import { EachMessagePayload } from 'kafkajs';
import { registerConsumer } from '@/infrastructure/kafka/consumer-manager';
import { KafkaTopic } from '@/infrastructure/kafka/topics';
// Import RetryableError from '@/common/errors' in handlers that call external
// services — throw it for transient failures so consumer-manager routes to retry queue.
import { logger } from '@/common/logger/logger';
import { metrics } from '@/metrics/metrics';

/**
 * Payment events consumer: processes PAYMENT_COMPLETED events for
 * downstream actions like analytics, accounting notifications, etc.
 *
 * Handlers throw RetryableError for transient failures (e.g. downstream service
 * temporarily unavailable). The consumer-manager routes those to the retry queue
 * with exponential backoff (1min → 5min → 30min), then DLQ if exhausted.
 * Non-retryable errors (bad data, business logic violations) propagate as plain
 * errors and go directly to the DLQ.
 *
 * These functions are exported so the payment-retry consumer can re-use them
 * without duplicating handler logic.
 */
export async function handlePaymentCompleted(payload: EachMessagePayload): Promise<void> {
  const raw = payload.message.value?.toString();
  if (!raw) return;

  const event = JSON.parse(raw) as {
    eventType: string;
    paymentId: string;
    merchantId: string;
    amount: number;
    currency: string;
    paymentMethod: string;
    timestamp: string;
  };

  logger.info(
    {
      paymentId: event.paymentId,
      merchantId: event.merchantId,
      amount: event.amount,
      topic: payload.topic,
    },
    'Processing PAYMENT_COMPLETED event',
  );

  // Example: call analytics service (transient failure → RetryableError)
  // try {
  //   await analyticsService.recordPayment(event);
  // } catch (err) {
  //   if (isTransientError(err)) throw new RetryableError('Analytics unavailable', err);
  //   throw err; // non-retryable → DLQ immediately
  // }

  metrics.paymentCompleted.inc({
    method: event.paymentMethod,
    currency: event.currency,
  });
}

export async function handlePaymentFailed(payload: EachMessagePayload): Promise<void> {
  const raw = payload.message.value?.toString();
  if (!raw) return;

  const event = JSON.parse(raw) as {
    paymentId: string;
    merchantId: string;
    failureReason: string;
  };

  logger.warn(
    { paymentId: event.paymentId, failureReason: event.failureReason },
    'Processing PAYMENT_FAILED event',
  );
  // Trigger merchant webhook notification, update analytics, etc.
}

export async function registerPaymentEventsConsumer(): Promise<void> {
  await registerConsumer({
    groupId: 'payment-events',
    topics: [
      KafkaTopic.PAYMENT_INITIATED,
      KafkaTopic.PAYMENT_COMPLETED,
      KafkaTopic.PAYMENT_FAILED,
      KafkaTopic.PAYMENT_EXPIRED,
    ],
    maxRetries: 3,
    handler: async (payload: EachMessagePayload) => {
      const eventType = payload.message.headers?.['eventType']?.toString();
      switch (eventType) {
        case 'PAYMENT_COMPLETED':
          await handlePaymentCompleted(payload);
          break;
        case 'PAYMENT_FAILED':
          await handlePaymentFailed(payload);
          break;
        default:
          logger.debug({ eventType, topic: payload.topic }, 'Unhandled event type in consumer');
      }
    },
  });
}
