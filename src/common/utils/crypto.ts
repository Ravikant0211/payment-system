import * as crypto from 'crypto';
import { appConfig } from '@/config';

/**
 * Hash an API key using SHA-256 with HMAC (using the application salt).
 * Stored in the database; never store raw API keys.
 */
export function hashApiKey(rawKey: string): string {
  return crypto
    .createHmac('sha256', appConfig.apiKeySalt)
    .update(rawKey)
    .digest('hex');
}

/** Generate a cryptographically random API key (base64url, 32 bytes = 43 chars) */
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Generate a UUID v4 */
export function generateId(): string {
  return crypto.randomUUID();
}

/** Hash arbitrary content (e.g. request body) for idempotency comparison */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Constant-time string comparison.
 * Prevents timing attacks when comparing sensitive values (API keys, tokens).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return crypto.timingSafeEqual(bufA, bufB);
}
