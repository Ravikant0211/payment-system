import { Pool } from 'pg';
import { PaymentRepository } from './payment.repository';
import { Payment } from './payment.entity';
import { CreatePaymentInput, ListPaymentsQuery } from './payment.schemas';
import { PaymentStatus } from './payment-status.enum';
import { OutboxRepository } from '@/infrastructure/outbox/outbox-repository';
import { KafkaTopic } from '@/infrastructure/kafka/topics';
import { createCheckoutSession } from '@/infrastructure/stripe/stripe-checkout';
import { withTransaction } from '@/infrastructure/database/transaction';
import { ConflictError, PaymentError } from '@/common/errors';
import { logger } from '@/common/logger/logger';
import { metrics } from '@/metrics/metrics';

export interface CreatePaymentResult {
  paymentId: string;
  checkoutUrl: string;
}

export interface PaymentPage {
  payments: Payment[];
  nextCursor: string | null;
}

/**
 * PaymentService: orchestrates the payment creation flow.
 *
 * Responsibilities:
 * - Idempotency check (DB layer)
 * - Create Stripe Checkout Session
 * - Persist payment + outbox row in a single DB transaction
 * - Emit metrics
 *
 * Follows the Single Responsibility Principle: this service only handles
 * payment creation and retrieval. State transitions are handled by the
 * WebhookService (which receives Stripe events).
 */
export class PaymentService {
  constructor(
    private readonly pool: Pool,
    private readonly paymentRepo: PaymentRepository,
    private readonly outboxRepo: OutboxRepository,
  ) {}

  async createPayment(
    merchantId: string,
    input: CreatePaymentInput,
  ): Promise<CreatePaymentResult> {
    // DB-level idempotency check (belt-and-suspenders beyond Redis middleware)
    const existing = await this.paymentRepo.findByIdempotencyKey(
      merchantId,
      input.orderId, // use orderId as natural idempotency key
    );
    if (existing) {
      if (existing.checkoutUrl) {
        logger.info(
          { paymentId: existing.id },
          'Returning existing payment (idempotent)',
        );
        return { paymentId: existing.id, checkoutUrl: existing.checkoutUrl };
      }
      throw new ConflictError(
        `Payment for order ${input.orderId} already exists with status ${existing.status}`,
      );
    }

    return withTransaction(this.pool, async (client) => {
      // 1. Create payment record
      const payment = await this.paymentRepo.create(client, {
        merchantId,
        orderId: input.orderId,
        customerId: input.customerId,
        idempotencyKey: input.orderId,
        amount: input.amount,
        currency: input.currency,
        paymentMethod: input.paymentMethod,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        metadata: input.metadata,
      });

      // 2. Create Stripe Checkout Session
      //    Done inside the transaction so if Stripe fails, the payment row rolls back.
      let sessionResult: Awaited<ReturnType<typeof createCheckoutSession>>;
      try {
        sessionResult = await createCheckoutSession({
          paymentId: payment.id,
          orderId: input.orderId,
          customerId: input.customerId,
          amount: input.amount,
          currency: input.currency,
          paymentMethod: input.paymentMethod,
          successUrl: input.successUrl,
          cancelUrl: input.cancelUrl,
          metadata: input.metadata,
        });
      } catch (err) {
        logger.error({ err, paymentId: payment.id }, 'Stripe checkout session creation failed');
        throw new PaymentError('Failed to create checkout session', err);
      }

      // 3. Update payment with Stripe session details
      const updatedPayment = await this.paymentRepo.updateStatus(client, {
        id: payment.id,
        status: PaymentStatus.PROCESSING,
        stripeSessionId: sessionResult.sessionId,
        checkoutUrl: sessionResult.checkoutUrl,
      });

      // 4. Record payment event for audit trail
      await this.paymentRepo.recordEvent(client, {
        paymentId: payment.id,
        eventType: 'PAYMENT_INITIATED',
        oldStatus: PaymentStatus.PENDING,
        newStatus: PaymentStatus.PROCESSING,
        actor: 'system',
        payload: {
          stripeSessionId: sessionResult.sessionId,
          expiresAt: sessionResult.expiresAt.toISOString(),
        },
      });

      // 5. Insert outbox row (same transaction — atomicity guaranteed)
      await this.outboxRepo.insert(client, {
        aggregateType: 'payment',
        aggregateId: payment.id,
        topic: KafkaTopic.PAYMENT_INITIATED,
        eventType: 'PAYMENT_INITIATED',
        payload: {
          eventType: 'PAYMENT_INITIATED',
          paymentId: payment.id,
          merchantId,
          orderId: input.orderId,
          customerId: input.customerId,
          amount: input.amount,
          currency: input.currency,
          paymentMethod: input.paymentMethod,
          stripeSessionId: sessionResult.sessionId,
          timestamp: new Date().toISOString(),
        },
      });

      // 6. Emit metrics
      metrics.paymentCreated.inc({
        method: input.paymentMethod,
        currency: input.currency,
      });
      metrics.paymentAmountMinorUnits.observe(
        { method: input.paymentMethod, currency: input.currency },
        input.amount,
      );

      logger.info(
        { paymentId: updatedPayment.id, merchantId, orderId: input.orderId },
        'Payment created successfully',
      );

      return {
        paymentId: updatedPayment.id,
        checkoutUrl: sessionResult.checkoutUrl,
      };
    });
  }

  async getPayment(id: string, merchantId: string): Promise<Payment> {
    const payment = await this.paymentRepo.findByIdOrThrow(id);
    if (payment.merchantId !== merchantId) {
      // Return 404 to avoid leaking that a payment exists for another merchant
      throw new Error(`Payment ${id} not found`);
    }
    return payment;
  }

  async listPayments(
    merchantId: string,
    query: ListPaymentsQuery,
  ): Promise<PaymentPage> {
    return this.paymentRepo.list({
      merchantId,
      cursor: query.cursor,
      limit: query.limit,
      status: query.status,
      fromDate: query.fromDate ? new Date(query.fromDate) : undefined,
      toDate: query.toDate ? new Date(query.toDate) : undefined,
    });
  }
}
