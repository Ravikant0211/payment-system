import { OutboxRepository } from './outbox-repository';
import { sendMessage } from '@/infrastructure/kafka/producer';
import { retryWithBackoff } from '@/common/utils/retry';
import { kafkaConfig } from '@/config';
import { logger } from '@/common/logger/logger';
import { metrics } from '@/metrics/metrics';

/**
 * Outbox Relay: polls the outbox table and publishes pending messages to Kafka.
 *
 * This implements the Transactional Outbox Pattern:
 * - Domain writes and outbox inserts happen in the same DB transaction.
 * - The relay guarantees at-least-once delivery to Kafka.
 * - Combined with Kafka's idempotent producer, this achieves effectively-once delivery.
 */
export class OutboxRelay {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(private readonly repo: OutboxRepository) {}

  start(): void {
    if (this.intervalHandle) return;

    this.intervalHandle = setInterval(
      () => void this.sweep(),
      kafkaConfig.outboxPollIntervalMs,
    );
    logger.info(
      { intervalMs: kafkaConfig.outboxPollIntervalMs },
      'Outbox relay started',
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    logger.info('Outbox relay stopped');
  }

  private async sweep(): Promise<void> {
    if (this.isRunning) return; // prevent overlapping sweeps
    this.isRunning = true;

    try {
      const rows = await this.repo.fetchPending(kafkaConfig.outboxMaxBatchSize);
      if (rows.length === 0) return;

      logger.debug({ count: rows.length }, 'Outbox relay processing batch');

      for (const row of rows) {
        try {
          // Retry with exponential backoff within a single sweep.
          // Attempt 1 → immediate, attempt 2 → ~600ms, attempt 3 → ~1.2s.
          // The retry count persisted in the DB gates how many sweeps a row survives;
          // this inner retry handles transient Kafka broker blips within one sweep.
          await retryWithBackoff(
            () =>
              sendMessage({
                topic: row.topic,
                key: row.aggregateId,
                value: row.payload,
                headers: {
                  eventType: row.eventType,
                  outboxId: row.id,
                  ...row.headers,
                },
              }),
            {
              maxAttempts: 2,           // 2 in-sweep attempts; outer sweep retries handle the rest
              initialDelayMs: 600,
              maxDelayMs: 2_000,
              jitterFactor: 0.25,
            },
          );
          await this.repo.markProcessed(row.id);
          metrics.outboxProcessed.inc({ topic: row.topic });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(
            { err, outboxId: row.id, topic: row.topic, retryCount: row.retryCount },
            'Outbox relay failed to publish message',
          );

          if (row.retryCount + 1 >= kafkaConfig.outboxMaxRetries) {
            await this.repo.markFailed(row.id, errMsg);
            metrics.outboxFailed.inc({ topic: row.topic });
            logger.error(
              { outboxId: row.id },
              'Outbox message moved to FAILED after max retries',
            );
          } else {
            await this.repo.incrementRetry(row.id, errMsg);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Outbox relay sweep error');
    } finally {
      this.isRunning = false;
    }
  }
}
