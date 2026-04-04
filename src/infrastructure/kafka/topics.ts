export const KafkaTopic = {
  PAYMENT_INITIATED:   'payment.initiated',
  PAYMENT_COMPLETED:   'payment.completed',
  PAYMENT_FAILED:      'payment.failed',
  PAYMENT_EXPIRED:     'payment.expired',
  REFUND_INITIATED:    'refund.initiated',
  REFUND_COMPLETED:    'refund.completed',
  RECONCILIATION_DONE: 'reconciliation.done',
  NOTIFICATION:        'notification',

  // Dedicated retry queue — retryable failures are routed here with a
  // scheduled_at delay (durable via outbox). The retry consumer re-processes
  // messages and either succeeds, re-enqueues, or promotes to DLQ.
  PAYMENT_RETRY: 'payment.retry',

  // Dead-letter topics — non-retryable failures or exhausted retry counts.
  // Named <original-topic>.dlq by convention.
  PAYMENT_INITIATED_DLQ: 'payment.initiated.dlq',
  PAYMENT_COMPLETED_DLQ: 'payment.completed.dlq',
  PAYMENT_FAILED_DLQ:    'payment.failed.dlq',
  PAYMENT_RETRY_DLQ:     'payment.retry.dlq',
} as const;

export type KafkaTopicValue = typeof KafkaTopic[keyof typeof KafkaTopic];
