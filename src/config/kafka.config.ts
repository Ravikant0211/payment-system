function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const kafkaConfig = {
  brokers: requireEnv('KAFKA_BROKERS').split(','),
  clientId: process.env['KAFKA_CLIENT_ID'] ?? 'payment-system',
  groupIdPrefix: process.env['KAFKA_GROUP_ID_PREFIX'] ?? 'payment-system',
  ssl: process.env['KAFKA_SSL'] === 'true',
  outboxPollIntervalMs: parseInt(
    process.env['OUTBOX_POLL_INTERVAL_MS'] ?? '500',
    10,
  ),
  outboxMaxBatchSize: parseInt(
    process.env['OUTBOX_MAX_BATCH_SIZE'] ?? '100',
    10,
  ),
  outboxMaxRetries: parseInt(process.env['OUTBOX_MAX_RETRIES'] ?? '5', 10),
  reconciliationCron: process.env['RECONCILIATION_CRON'] ?? '0 2 * * *',
} as const;
