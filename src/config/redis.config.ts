function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const redisConfig = {
  url: requireEnv('REDIS_URL'),
  keyPrefix: process.env['REDIS_KEY_PREFIX'] ?? 'payment:',
  idempotencyKeyTtlSeconds: parseInt(
    process.env['IDEMPOTENCY_KEY_TTL_SECONDS'] ?? '86400',
    10,
  ),
  apiKeyCacheTtlSeconds: 300,
} as const;
