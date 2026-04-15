import { Consumer, EachMessagePayload } from 'kafkajs';
import { Pool } from 'pg';
import { getKafkaClient } from './kafka-client';
import { kafkaConfig } from '@/config';
import { logger } from '@/common/logger/logger';
import { sendMessage } from './producer';
import { KafkaTopic } from './topics';
import { OutboxRepository } from '@/infrastructure/outbox/outbox-repository';
import { RetryableError } from '@/common/errors';

/**
 * Retry delay schedule (exponential, capped).
 * Attempt 1 → 1 minute, attempt 2 → 5 minutes, attempt 3 → 30 minutes, then DLQ.
 */
const RETRY_DELAY_MS = [
  1  * 60 * 1000,   //  1 min
  5  * 60 * 1000,   //  5 min
  30 * 60 * 1000,   // 30 min
];

interface ConsumerRegistration {
  groupId: string;
  topics: string[];
  handler: (payload: EachMessagePayload) => Promise<void>;
  /**
   * Maximum number of retry attempts before the message is promoted to DLQ.
   * Defaults to RETRY_DELAY_MS.length (3). Each retry is durable — it survives
   * a process crash because it is persisted in the outbox table.
   */
  maxRetries?: number;
}

const registrations: Array<{ consumer: Consumer; topics: string[] }> = [];

let outboxRepo: OutboxRepository | null = null;

/**
 * Must be called before any registerConsumer() calls.
 * The outbox repository is used to durably schedule retries.
 */
export function initConsumerManager(pool: Pool): void {
  outboxRepo = new OutboxRepository(pool);
}

/**
 * Registers a Kafka consumer group implementing Figure 12 from the architecture:
 *
 *   Failure → Retryable? (RetryableError thrown by handler)
 *     1a) Yes → Retry Queue (payment.retry via outbox, exponential delay)
 *     1b) No  → Dead Letter Queue (immediately, no retry)
 *
 *   Retry Queue → handler → Failure → Retryable?
 *     3a) Yes (and retries remaining) → back to Retry Queue with longer delay
 *     3b) No or retries exhausted     → Dead Letter Queue
 *
 * Key difference from the previous approach:
 * - Retries are DURABLE: persisted in the outbox table before committing the offset.
 *   A process crash between "offset commit" and "retry enqueue" cannot lose the retry.
 * - Retries are DECOUPLED: the consumer partition is not blocked during the retry delay.
 *   Long delays (5min, 30min) are safe because they run outside the consumer thread.
 * - Non-retryable errors go DIRECTLY to DLQ — no wasted retry attempts.
 */
export async function registerConsumer(
  reg: ConsumerRegistration,
): Promise<void> {
  const groupId = `${kafkaConfig.groupIdPrefix}.${reg.groupId}`;
  const maxRetries = reg.maxRetries ?? RETRY_DELAY_MS.length;

  const consumer = getKafkaClient().consumer({
    groupId,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
  });

  await consumer.connect();
  await consumer.subscribe({ topics: reg.topics, fromBeginning: false });

  await consumer.run({
    autoCommit: false,
    eachMessage: async (payload) => {
      const { topic, partition, message } = payload;
      const offset = message.offset;

      // Read retry count from message header (set by retry consumer on re-enqueue)
      const retryCount = parseInt(
        message.headers?.['x-retry-count']?.toString() ?? '0',
        10,
      );
      const originalTopic =
        message.headers?.['x-original-topic']?.toString() ?? topic;

      try {
        await reg.handler(payload);

        await consumer.commitOffsets([
          { topic, partition, offset: String(BigInt(offset) + 1n) },
        ]);
      } catch (err) {
        const isRetryable = err instanceof RetryableError;
        const hasRetriesLeft = retryCount < maxRetries;

        if (isRetryable && hasRetriesLeft) {
          // ── Path 1a / 3a: Retryable → Retry Queue ───────────────────────
          const delayMs = RETRY_DELAY_MS[retryCount] ?? RETRY_DELAY_MS[RETRY_DELAY_MS.length - 1]!;
          const scheduledAt = new Date(Date.now() + delayMs);

          logger.warn(
            {
              err,
              topic,
              partition,
              offset,
              retryCount,
              nextRetryAt: scheduledAt.toISOString(),
              delayMs,
            },
            'Retryable failure — scheduling retry via outbox',
          );

          await enqueueRetry({
            originalTopic,
            message,
            retryCount: retryCount + 1,
            scheduledAt,
            error: err instanceof Error ? err.message : String(err),
          });

          // Commit so this partition is not blocked while the retry waits
          await consumer.commitOffsets([
            { topic, partition, offset: String(BigInt(offset) + 1n) },
          ]);
        } else {
          // ── Path 1b / 3b: Non-retryable or exhausted → DLQ ──────────────
          const reason = isRetryable
            ? `Exhausted ${maxRetries} retries`
            : 'Non-retryable error';

          logger.error(
            { err, topic, partition, offset, retryCount, reason },
            'Message routed to dead-letter queue',
          );

          const dlqKey = message.key?.toString();
          await sendMessage({
            topic: `${originalTopic}.dlq`,
            ...(dlqKey ? { key: dlqKey } : {}),
            value: {
              originalTopic,
              partition,
              offset,
              retryCount,
              payload: message.value?.toString(),
              headers: Object.fromEntries(
                Object.entries(message.headers ?? {}).map(([k, v]) => [
                  k,
                  v?.toString() ?? '',
                ]),
              ),
              error: err instanceof Error ? err.message : String(err),
              reason,
              failedAt: new Date().toISOString(),
            },
          });

          await consumer.commitOffsets([
            { topic, partition, offset: String(BigInt(offset) + 1n) },
          ]);
        }
      }
    },
  });

  registrations.push({ consumer, topics: reg.topics });
  logger.info({ groupId, topics: reg.topics }, 'Kafka consumer registered');
}

/**
 * Durably schedules a retry via the outbox table.
 * The outbox relay will publish to `payment.retry` when `scheduledAt` is reached.
 * Using the outbox here (rather than direct Kafka produce) means a crash between
 * "offset commit" and "retry publish" cannot silently drop the retry.
 */
async function enqueueRetry(params: {
  originalTopic: string;
  message: EachMessagePayload['message'];
  retryCount: number;
  scheduledAt: Date;
  error: string;
}): Promise<void> {
  if (!outboxRepo) {
    throw new Error(
      'OutboxRepository not initialised — call initConsumerManager(pool) at startup',
    );
  }

  const rawPayload = params.message.value?.toString();
  let payload: unknown;
  try {
    payload = rawPayload ? JSON.parse(rawPayload) : null;
  } catch {
    payload = rawPayload;
  }

  // Embed retry metadata as headers so the retry consumer can read them
  const originalHeaders = Object.fromEntries(
    Object.entries(params.message.headers ?? {}).map(([k, v]) => [
      k,
      v?.toString() ?? '',
    ]),
  );

  await outboxRepo.insertRetry({
    aggregateType: 'payment-retry',
    aggregateId: params.message.key?.toString() ?? 'unknown',
    topic: KafkaTopic.PAYMENT_RETRY,
    eventType: originalHeaders['eventType'] ?? 'UNKNOWN',
    payload,
    headers: {
      ...originalHeaders,
      'x-retry-count':    String(params.retryCount),
      'x-original-topic': params.originalTopic,
      'x-retry-error':    params.error,
      'x-scheduled-at':   params.scheduledAt.toISOString(),
    },
    scheduledAt: params.scheduledAt,
  });
}

export async function disconnectAllConsumers(): Promise<void> {
  for (const { consumer, topics } of registrations.reverse()) {
    logger.info({ topics }, 'Disconnecting Kafka consumer');
    await consumer.disconnect();
  }
  registrations.length = 0;
}
