import Stripe from 'stripe';
import { PoolClient } from 'pg';
import { PaymentRepository } from '@/domains/payment/payment.repository';
import { LedgerService } from '@/domains/ledger/ledger.service';
import { OutboxRepository } from '@/infrastructure/outbox/outbox-repository';
import { KafkaTopic } from '@/infrastructure/kafka/topics';
import { PaymentStatus } from '@/domains/payment/payment-status.enum';
import { logger } from '@/common/logger/logger';
import { metrics } from '@/metrics/metrics';

/**
 * Handles checkout.session.completed Stripe events.
 *
 * All writes happen within the outer transaction provided by WebhookService.
 * This ensures that payment status update, ledger entries, and outbox insert
 * are all atomic — either all succeed or all roll back.
 */
export async function handleCheckoutSessionCompleted(
  client: PoolClient,
  session: Stripe.Checkout.Session,
  paymentRepo: PaymentRepository,
  ledgerService: LedgerService,
  outboxRepo: OutboxRepository,
): Promise<void> {
  const paymentId = session.metadata?.['paymentId'];
  if (!paymentId) {
    logger.warn(
      { sessionId: session.id },
      'checkout.session.completed missing paymentId in metadata',
    );
    return;
  }

  // Update payment to COMPLETED
  const stripePaymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent?.id ?? undefined);

  const payment = await paymentRepo.updateStatus(client, {
    id: paymentId,
    status: PaymentStatus.COMPLETED,
    ...(stripePaymentIntentId ? { stripePaymentIntentId } : {}),
  });

  // Record payment event
  await paymentRepo.recordEvent(client, {
    paymentId,
    eventType: 'PAYMENT_COMPLETED',
    oldStatus: PaymentStatus.PROCESSING,
    newStatus: PaymentStatus.COMPLETED,
    actor: 'stripe_webhook',
    payload: { stripeSessionId: session.id },
  });

  // Double-entry ledger: DEBIT RECEIVABLE, CREDIT REVENUE
  await ledgerService.recordPaymentReceived(
    client,
    paymentId,
    payment.amount,
    payment.currency,
  );

  // Stripe fee if available (requires charge.succeeded or invoice events for exact fee)
  // If Stripe provides the fee in the payment intent, record it
  const amountReceived = session.amount_total ?? payment.amount;
  const stripeFee = payment.amount - amountReceived;
  if (stripeFee > 0) {
    await ledgerService.recordStripeFee(client, paymentId, stripeFee, payment.currency);
  }

  // Publish PAYMENT_COMPLETED event via outbox
  await outboxRepo.insert(client, {
    aggregateType: 'payment',
    aggregateId: paymentId,
    topic: KafkaTopic.PAYMENT_COMPLETED,
    eventType: 'PAYMENT_COMPLETED',
    payload: {
      eventType: 'PAYMENT_COMPLETED',
      paymentId,
      merchantId: payment.merchantId,
      orderId: payment.orderId,
      customerId: payment.customerId,
      amount: payment.amount,
      currency: payment.currency,
      paymentMethod: payment.paymentMethod,
      stripeSessionId: session.id,
      timestamp: new Date().toISOString(),
    },
  });

  metrics.paymentCompleted.inc({
    method: payment.paymentMethod,
    currency: payment.currency,
  });

  logger.info(
    { paymentId, sessionId: session.id },
    'Payment completed and ledger updated',
  );
}
