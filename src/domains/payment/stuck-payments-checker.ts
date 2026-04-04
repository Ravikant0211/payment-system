import { Pool, PoolClient } from 'pg';
import { PaymentRepository } from './payment.repository';
import { OutboxRepository } from '@/infrastructure/outbox/outbox-repository';
import { Payment } from './payment.entity';
import { PaymentStatus, PaymentMethod, PaymentMethodValue } from './payment-status.enum';
import { retrieveCheckoutSession } from '@/infrastructure/stripe/stripe-checkout';
import { withTransaction } from '@/infrastructure/database/transaction';
import { KafkaTopic } from '@/infrastructure/kafka/topics';
import { logger } from '@/common/logger/logger';
import { metrics } from '@/metrics/metrics';

/**
 * Age thresholds before a payment in PROCESSING is considered stuck.
 *
 * Card payments: Stripe checkout sessions expire after 30 min, so 35 min
 *   gives a 5-minute buffer for the webhook to arrive.
 *
 * UPI / Net Banking: Bank processing is async and can take 1-3 hours.
 *   We use 3 hours to avoid false positives while still catching genuine failures.
 */
const STUCK_THRESHOLD_MINUTES: Record<PaymentMethodValue, number> = {
  [PaymentMethod.CREDIT_CARD]: 35,
  [PaymentMethod.DEBIT_CARD]:  35,
  [PaymentMethod.UPI]:         180,  // 3 hours
  [PaymentMethod.NET_BANKING]: 180,
};

// Run the checker every 5 minutes; use the shortest threshold to decide what to fetch
const MINIMUM_THRESHOLD_MINUTES = Math.min(...Object.values(STUCK_THRESHOLD_MINUTES));

export class StuckPaymentsChecker {
  private readonly paymentRepo: PaymentRepository;
  private readonly outboxRepo: OutboxRepository;

  constructor(private readonly pool: Pool) {
    this.paymentRepo = new PaymentRepository(pool);
    this.outboxRepo = new OutboxRepository(pool);
  }

  /**
   * Entry point — called by the cron scheduler every 5 minutes.
   * Fetches all payments older than the minimum threshold, then applies
   * per-method thresholds before taking action.
   */
  async run(): Promise<void> {
    const candidates = await this.paymentRepo.findStuckPayments(
      MINIMUM_THRESHOLD_MINUTES,
    );

    if (candidates.length === 0) return;

    logger.info({ count: candidates.length }, 'StuckPaymentsChecker: evaluating candidates');

    for (const payment of candidates) {
      const threshold = STUCK_THRESHOLD_MINUTES[payment.paymentMethod];
      const ageMinutes = minutesSince(payment.updatedAt);

      if (ageMinutes < threshold) continue; // not yet past this method's threshold

      await this.evaluate(payment).catch((err) => {
        logger.error(
          { err, paymentId: payment.id, ageMinutes },
          'StuckPaymentsChecker: evaluation failed for payment',
        );
      });
    }
  }

  /**
   * Evaluate a single stuck payment:
   * 1. If we have a Stripe session ID, query Stripe for the current status.
   * 2. Map the Stripe status to our internal status and update accordingly.
   * 3. If Stripe reports success/failure we didn't catch via webhook — reconcile now.
   * 4. If Stripe still shows the session as open/pending — mark FAILED (timed out).
   */
  private async evaluate(payment: Payment): Promise<void> {
    const ageMinutes = minutesSince(payment.updatedAt);
    logger.warn(
      { paymentId: payment.id, method: payment.paymentMethod, ageMinutes },
      'StuckPaymentsChecker: payment is stuck',
    );
    metrics.stuckPaymentsDetected.inc({ method: payment.paymentMethod });

    if (!payment.stripeSessionId) {
      // No session was ever created — transition directly to FAILED
      await this.transitionToFailed(payment, 'No Stripe session created');
      return;
    }

    let session: Awaited<ReturnType<typeof retrieveCheckoutSession>>;
    try {
      session = await retrieveCheckoutSession(payment.stripeSessionId);
    } catch (err) {
      logger.error(
        { err, paymentId: payment.id, sessionId: payment.stripeSessionId },
        'StuckPaymentsChecker: failed to retrieve Stripe session',
      );
      return; // do not mark as failed — Stripe may be temporarily unavailable
    }

    logger.info(
      { paymentId: payment.id, sessionStatus: session.status },
      'StuckPaymentsChecker: Stripe session status retrieved',
    );

    switch (session.status) {
      case 'complete':
        // Webhook was missed or delayed — manually complete the payment
        await this.transitionToCompleted(payment, session.payment_intent as string | null);
        break;

      case 'expired':
        await this.transitionToFailed(payment, 'Stripe session expired without payment');
        break;

      case 'open':
        // For UPI/net banking, "open" can be legitimate processing.
        // Only mark as failed if the session itself has passed its expiry time.
        if (session.expires_at && session.expires_at * 1000 < Date.now()) {
          await this.transitionToFailed(
            payment,
            `Payment timed out after ${ageMinutes} minutes (session expired)`,
          );
        } else {
          logger.info(
            { paymentId: payment.id, method: payment.paymentMethod },
            'StuckPaymentsChecker: session still open, will re-check on next run',
          );
        }
        break;

      default:
        logger.warn(
          { paymentId: payment.id, sessionStatus: session.status },
          'StuckPaymentsChecker: unexpected session status',
        );
    }
  }

  private async transitionToCompleted(
    payment: Payment,
    stripePaymentIntentId: string | null,
  ): Promise<void> {
    logger.info(
      { paymentId: payment.id },
      'StuckPaymentsChecker: completing missed payment',
    );

    await withTransaction(this.pool, async (client: PoolClient) => {
      await this.paymentRepo.updateStatus(client, {
        id: payment.id,
        status: PaymentStatus.COMPLETED,
        stripePaymentIntentId: stripePaymentIntentId ?? undefined,
      });

      await this.paymentRepo.recordEvent(client, {
        paymentId: payment.id,
        eventType: 'PAYMENT_COMPLETED_RECOVERED',
        oldStatus: PaymentStatus.PROCESSING,
        newStatus: PaymentStatus.COMPLETED,
        actor: 'stuck_payments_checker',
        payload: { reason: 'Webhook was missed; status recovered by polling Stripe' },
      });

      await this.outboxRepo.insert(client, {
        aggregateType: 'payment',
        aggregateId: payment.id,
        topic: KafkaTopic.PAYMENT_COMPLETED,
        eventType: 'PAYMENT_COMPLETED',
        payload: {
          eventType: 'PAYMENT_COMPLETED',
          paymentId: payment.id,
          merchantId: payment.merchantId,
          orderId: payment.orderId,
          customerId: payment.customerId,
          amount: payment.amount,
          currency: payment.currency,
          paymentMethod: payment.paymentMethod,
          recoveredByChecker: true,
          timestamp: new Date().toISOString(),
        },
      });
    });

    metrics.stuckPaymentsRecovered.inc({ method: payment.paymentMethod, outcome: 'completed' });
  }

  private async transitionToFailed(
    payment: Payment,
    reason: string,
  ): Promise<void> {
    logger.warn(
      { paymentId: payment.id, reason },
      'StuckPaymentsChecker: marking payment as failed',
    );

    await withTransaction(this.pool, async (client: PoolClient) => {
      await this.paymentRepo.updateStatus(client, {
        id: payment.id,
        status: PaymentStatus.FAILED,
        failureReason: reason,
      });

      await this.paymentRepo.recordEvent(client, {
        paymentId: payment.id,
        eventType: 'PAYMENT_FAILED_TIMEOUT',
        oldStatus: PaymentStatus.PROCESSING,
        newStatus: PaymentStatus.FAILED,
        actor: 'stuck_payments_checker',
        payload: { reason },
      });

      await this.outboxRepo.insert(client, {
        aggregateType: 'payment',
        aggregateId: payment.id,
        topic: KafkaTopic.PAYMENT_FAILED,
        eventType: 'PAYMENT_FAILED',
        payload: {
          eventType: 'PAYMENT_FAILED',
          paymentId: payment.id,
          merchantId: payment.merchantId,
          failureReason: reason,
          timedOut: true,
          timestamp: new Date().toISOString(),
        },
      });
    });

    metrics.stuckPaymentsRecovered.inc({ method: payment.paymentMethod, outcome: 'failed' });
  }
}

function minutesSince(date: Date): number {
  return (Date.now() - date.getTime()) / 60_000;
}
