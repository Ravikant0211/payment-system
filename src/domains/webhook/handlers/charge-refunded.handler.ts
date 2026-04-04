import Stripe from 'stripe';
import { PoolClient } from 'pg';
import { PaymentRepository } from '@/domains/payment/payment.repository';
import { LedgerService } from '@/domains/ledger/ledger.service';
import { OutboxRepository } from '@/infrastructure/outbox/outbox-repository';
import { KafkaTopic } from '@/infrastructure/kafka/topics';
import { PaymentStatus } from '@/domains/payment/payment-status.enum';
import { logger } from '@/common/logger/logger';

export async function handleChargeRefunded(
  client: PoolClient,
  charge: Stripe.Charge,
  paymentRepo: PaymentRepository,
  ledgerService: LedgerService,
  outboxRepo: OutboxRepository,
): Promise<void> {
  const paymentId = charge.metadata?.['paymentId'];
  if (!paymentId) {
    logger.warn({ chargeId: charge.id }, 'charge.refunded missing paymentId in metadata');
    return;
  }

  const payment = await paymentRepo.updateStatus(client, {
    id: paymentId,
    status: PaymentStatus.REFUNDED,
  });

  await paymentRepo.recordEvent(client, {
    paymentId,
    eventType: 'PAYMENT_REFUNDED',
    oldStatus: PaymentStatus.COMPLETED,
    newStatus: PaymentStatus.REFUNDED,
    actor: 'stripe_webhook',
    payload: { chargeId: charge.id, amountRefunded: charge.amount_refunded },
  });

  // Reverse ledger entries
  await ledgerService.recordRefund(
    client,
    paymentId,
    charge.amount_refunded,
    charge.currency.toUpperCase(),
  );

  await outboxRepo.insert(client, {
    aggregateType: 'payment',
    aggregateId: paymentId,
    topic: KafkaTopic.REFUND_COMPLETED,
    eventType: 'REFUND_COMPLETED',
    payload: {
      eventType: 'REFUND_COMPLETED',
      paymentId,
      merchantId: payment.merchantId,
      amountRefunded: charge.amount_refunded,
      currency: charge.currency.toUpperCase(),
      timestamp: new Date().toISOString(),
    },
  });

  logger.info({ paymentId, amountRefunded: charge.amount_refunded }, 'Charge refunded');
}
