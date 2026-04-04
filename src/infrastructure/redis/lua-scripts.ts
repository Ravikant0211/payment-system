import { Redis } from 'ioredis';

/**
 * Atomic set-if-not-exists with TTL.
 * Returns the existing value if the key already exists, or null if it was newly set.
 * Prevents TOCTOU race conditions in idempotency checks.
 */
const SET_IF_NOT_EXISTS_SCRIPT = `
  local existing = redis.call('GET', KEYS[1])
  if existing then return existing end
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return nil
`;

export async function setIfNotExists(
  redis: Redis,
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<string | null> {
  const result = await redis.eval(
    SET_IF_NOT_EXISTS_SCRIPT,
    1,
    key,
    value,
    String(ttlSeconds),
  );
  return result as string | null;
}
