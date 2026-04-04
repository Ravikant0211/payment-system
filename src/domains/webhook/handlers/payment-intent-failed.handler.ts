import Stripe from 'stripe';
import { PoolClient } from 'pg';
import { PaymentRepository } from '@/domains/payment/payment.repository';
import { OutboxRepository } from '@/infrastructure/outbox/outbox-repository';
import { KafkaTopic } from '@/infrastructure/kafka/topics';
import { PaymentStatus } from '@/domains/payment/payment-status.enum';
import { logger } from '@/common/logger/logger';
import { metrics } from '@/metrics/metrics';

export async function handlePaymentIntentFailed(
  client: PoolClient,
  paymentIntent: Stripe.PaymentIntent,
  paymentRepo: PaymentRepository,
  outboxRepo: OutboxRepository,
): Promise<void> {
  // Find payment by Stripe session — payment_intent.metadata may carry paymentId
  const paymentId = paymentIntent.metadata?.['paymentId'];
  if (!paymentId) {
    logger.warn(
      { paymentIntentId: paymentIntent.id },
      'payment_intent.payment_failed missing paymentId in metadata',
    );
    return;
  }

  const failureReason =
    paymentIntent.last_payment_error?.message ?? 'Payment failed';

  const payment = await paymentRepo.updateStatus(client, {
    id: paymentId,
    status: PaymentStatus.FAILED,
    failureReason,
  });

  await paymentRepo.recordEvent(client, {
    paymentId,
    eventType: 'PAYMENT_FAILED',
    oldStatus: PaymentStatus.PROCESSING,
    newStatus: PaymentStatus.FAILED,
    actor: 'stripe_webhook',
    payload: {
      paymentIntentId: paymentIntent.id,
      failureCode: paymentIntent.last_payment_error?.code,
      failureMessage: failureReason,
    },
  });

  await outboxRepo.insert(client, {
    aggregateType: 'payment',
    aggregateId: paymentId,
    topic: KafkaTopic.PAYMENT_FAILED,
    eventType: 'PAYMENT_FAILED',
    payload: {
      eventType: 'PAYMENT_FAILED',
      paymentId,
      merchantId: payment.merchantId,
      failureReason,
      timestamp: new Date().toISOString(),
    },
  });

  metrics.paymentFailed.inc({
    method: payment.paymentMethod,
    currency: payment.currency,
    reason: paymentIntent.last_payment_error?.code ?? 'unknown',
  });

  logger.warn(
    { paymentId, failureReason },
    'Payment failed',
  );
}
