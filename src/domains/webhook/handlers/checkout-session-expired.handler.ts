import Stripe from 'stripe';
import { PoolClient } from 'pg';
import { PaymentRepository } from '@/domains/payment/payment.repository';
import { OutboxRepository } from '@/infrastructure/outbox/outbox-repository';
import { KafkaTopic } from '@/infrastructure/kafka/topics';
import { PaymentStatus } from '@/domains/payment/payment-status.enum';
import { logger } from '@/common/logger/logger';

export async function handleCheckoutSessionExpired(
  client: PoolClient,
  session: Stripe.Checkout.Session,
  paymentRepo: PaymentRepository,
  outboxRepo: OutboxRepository,
): Promise<void> {
  const paymentId = session.metadata?.['paymentId'];
  if (!paymentId) return;

  await paymentRepo.updateStatus(client, {
    id: paymentId,
    status: PaymentStatus.EXPIRED,
    failureReason: 'Checkout session expired without payment',
  });

  await paymentRepo.recordEvent(client, {
    paymentId,
    eventType: 'PAYMENT_EXPIRED',
    oldStatus: PaymentStatus.PROCESSING,
    newStatus: PaymentStatus.EXPIRED,
    actor: 'stripe_webhook',
    payload: { stripeSessionId: session.id },
  });

  await outboxRepo.insert(client, {
    aggregateType: 'payment',
    aggregateId: paymentId,
    topic: KafkaTopic.PAYMENT_EXPIRED,
    eventType: 'PAYMENT_EXPIRED',
    payload: {
      eventType: 'PAYMENT_EXPIRED',
      paymentId,
      stripeSessionId: session.id,
      timestamp: new Date().toISOString(),
    },
  });

  logger.info({ paymentId, sessionId: session.id }, 'Payment expired');
}
