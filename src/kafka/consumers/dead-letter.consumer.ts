import { EachMessagePayload } from 'kafkajs';
import { Pool } from 'pg';
import { registerConsumer } from '@/infrastructure/kafka/consumer-manager';
import { KafkaTopic } from '@/infrastructure/kafka/topics';
import { sendAlert } from '@/infrastructure/alerting/slack-alerter';
import { logger } from '@/common/logger/logger';
import { metrics } from '@/metrics/metrics';

/**
 * Dead-letter consumer: reads from all *.dlq topics.
 *
 * Responsibilities:
 * - Log DLQ messages at ERROR level for immediate visibility
 * - Persist to dead_letter_messages table for operator review
 * - Increment Prometheus counter (triggers Grafana alert)
 *
 * Operators can replay messages via POST /admin/dlq/:id/replay
 */
async function storeDlqMessage(
  pool: Pool,
  topic: string,
  partition: number,
  offset: string,
  payload: unknown,
  error: string,
): Promise<void> {
  const parsed = typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : {};

  await pool.query(
    `INSERT INTO dead_letter_messages
       (topic, partition, kafka_offset, payment_id, event_type, payload, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      topic,
      partition,
      parseInt(offset, 10),
      parsed['paymentId'] ?? null,
      parsed['eventType'] ?? null,
      JSON.stringify(payload),
      error,
    ],
  );
}

export async function registerDeadLetterConsumer(pool: Pool): Promise<void> {
  const dlqTopics = [
    KafkaTopic.PAYMENT_INITIATED_DLQ,
    KafkaTopic.PAYMENT_COMPLETED_DLQ,
    KafkaTopic.PAYMENT_FAILED_DLQ,
  ];

  await registerConsumer({
    groupId: 'dead-letter',
    topics: dlqTopics,
    maxRetries: 1, // Don't retry DLQ processing
    handler: async (payload: EachMessagePayload) => {
      const { topic, partition, message } = payload;
      const raw = message.value?.toString();
      let parsed: unknown = raw;

      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        // Keep raw string if not valid JSON
      }

      const error = typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['error'] as string ?? 'unknown'
        : 'unknown';

      // Log at ERROR level — these require human attention
      logger.error(
        { topic, partition, offset: message.offset, payload: parsed },
        'DLQ message received — manual intervention required',
      );

      metrics.dlqMessagesTotal.inc({ topic });

      const paymentId = typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)['paymentId'] as string | undefined
        : undefined;

      // Alert ops — fire and forget, never throws
      void sendAlert({
        severity: 'critical',
        title: `Dead-letter message on ${topic}`,
        message: `A message could not be processed after all retries and was routed to the DLQ.\nManual replay required via \`POST /admin/dlq/:id/replay\`.`,
        fields: {
          Topic: topic,
          Partition: partition,
          Offset: message.offset,
          ...(paymentId ? { 'Payment ID': paymentId } : {}),
          Error: error,
        },
      });

      // Persist for operator review
      await storeDlqMessage(
        pool,
        topic,
        partition,
        message.offset,
        parsed,
        error,
      );
    },
  });
}
