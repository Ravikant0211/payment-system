import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { hashApiKey } from '@/common/utils/crypto';
import { UnauthorizedError } from '@/common/errors';
import { redisConfig } from '@/config';
import { logger } from '@/common/logger/logger';

interface MerchantRecord {
  id: string;
  name: string;
  status: string;
}

/**
 * API Key authentication middleware.
 * 1. Extracts Bearer token from Authorization header.
 * 2. Hashes it and checks Redis cache (fast path).
 * 3. On cache miss, queries PostgreSQL (slow path) then warms cache.
 * 4. Attaches merchant to req.merchant.
 *
 * Uses HMAC hash comparison — raw keys never stored or logged.
 */
export function createAuthMiddleware(pool: Pool, redis: Redis) {
  return async function authenticate(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      return next(new UnauthorizedError('Missing or malformed Authorization header'));
    }

    const rawKey = authHeader.slice(7).trim();
    if (!rawKey) {
      return next(new UnauthorizedError('Empty API key'));
    }

    const keyHash = hashApiKey(rawKey);
    const cacheKey = `api-key:${keyHash}`;

    try {
      // Fast path: Redis cache
      const cached = await redis.get(cacheKey);
      if (cached) {
        const merchant = JSON.parse(cached) as MerchantRecord;
        if (merchant.status !== 'ACTIVE') {
          return next(new UnauthorizedError('Merchant account is not active'));
        }
        req.merchant = merchant;
        await redis.expire(cacheKey, redisConfig.apiKeyCacheTtlSeconds);
        return next();
      }

      // Slow path: database lookup
      const { rows } = await pool.query<MerchantRecord>(
        `SELECT id, name, status FROM merchants WHERE api_key_hash = $1`,
        [keyHash],
      );

      const merchant = rows[0];
      if (!merchant) {
        return next(new UnauthorizedError('Invalid API key'));
      }
      if (merchant.status !== 'ACTIVE') {
        return next(new UnauthorizedError('Merchant account is not active'));
      }

      await redis.set(
        cacheKey,
        JSON.stringify(merchant),
        'EX',
        redisConfig.apiKeyCacheTtlSeconds,
      );

      req.merchant = merchant;
      return next();
    } catch (err) {
      logger.error({ err }, 'Auth middleware error');
      return next(err);
    }
  };
}
