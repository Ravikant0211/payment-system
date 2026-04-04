import { EachMessagePayload } from 'kafkajs';
import { registerConsumer } from '@/infrastructure/kafka/consumer-manager';
import { KafkaTopic } from '@/infrastructure/kafka/topics';
import { RetryableError } from '@/common/errors';
import { logger } from '@/common/logger/logger';
import { metrics } from '@/metrics/metrics';

/**
 * Retry Queue Consumer — processes messages from `payment.retry`.
 *
 * The outbox relay publishes to this topic only when scheduled_at <= NOW(),
 * so by the time a message arrives here the backoff delay has already elapsed.
 *
 * This consumer delegates to the same event handlers as the original consumers.
 * On success: done, offset committed.
 * On retryable failure: consumer-manager re-enqueues with the next backoff tier.
 * On non-retryable failure or exhausted retries: consumer-manager routes to DLQ.
 *
 * The retry count is carried in the `x-retry-count` header so the consumer-manager
 * can enforce the maxRetries limit regardless of which topic the message came from.
 */

// Import the same handlers used by the primary payment consumer
import { handlePaymentCompleted, handlePaymentFailed } from './payment-events.consumer';

async function handleRetryMessage(payload: EachMessagePayload): Promise<void> {
  const { message } = payload;
  const raw = message.value?.toString();
  if (!raw) return;

  const eventType = message.headers?.['eventType']?.toString();
  const retryCount = parseInt(
    message.headers?.['x-retry-count']?.toString() ?? '1',
    10,
  );
  const originalTopic = message.headers?.['x-original-topic']?.toString() ?? 'unknown';

  logger.info(
    { eventType, retryCount, originalTopic, offset: message.offset },
    'Retry queue: processing message',
  );

  metrics.retryQueueProcessed.inc({ eventType: eventType ?? 'unknown' });

  // Re-dispatch to the same handler that originally failed.
  // If the underlying condition is still present, a RetryableError will propagate
  // back to consumer-manager, which will re-enqueue with the next tier delay.
  switch (eventType) {
    case 'PAYMENT_COMPLETED':
      await handlePaymentCompleted(payload);
      break;
    case 'PAYMENT_FAILED':
      await handlePaymentFailed(payload);
      break;
    default:
      // Unknown event type in retry queue — not retryable, will go to DLQ
      throw new Error(
        `Retry queue: unrecognised event type '${eventType}' — routing to DLQ`,
      );
  }

  logger.info(
    { eventType, retryCount, originalTopic },
    'Retry queue: message processed successfully',
  );
}

export async function registerPaymentRetryConsumer(): Promise<void> {
  await registerConsumer({
    groupId: 'payment-retry',
    topics: [KafkaTopic.PAYMENT_RETRY],
    maxRetries: 3, // Total retries across all tiers (1min + 5min + 30min)
    handler: handleRetryMessage,
  });
}
