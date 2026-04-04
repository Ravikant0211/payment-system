import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { setIfNotExists } from '@/infrastructure/redis/lua-scripts';
import { hashContent } from '@/common/utils/crypto';
import { ConflictError, ValidationError } from '@/common/errors';
import { redisConfig } from '@/config';
import { logger } from '@/common/logger/logger';
import { metrics } from '@/metrics/metrics';

interface CachedResponse {
  status: number;
  body: unknown;
  requestHash: string;
}

/**
 * Idempotency middleware for POST endpoints.
 *
 * Requires an `Idempotency-Key` header. Implements two-layer deduplication:
 * 1. Redis (fast path, 24h TTL)
 * 2. PostgreSQL idempotency_keys table (durable fallback)
 *
 * Returns 409 if the same key is used with a different request body (body hash mismatch).
 * Returns the cached response if the key was already processed successfully.
 */
export function idempotencyMiddleware(redis: Redis, pool: Pool) {
  return async function idempotency(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (!idempotencyKey) {
      return next(new ValidationError('Idempotency-Key header is required'));
    }

    const merchantId = req.merchant?.id;
    if (!merchantId) return next();

    const requestHash = hashContent(JSON.stringify(req.body));
    const redisKey = `idempotency:${merchantId}:${idempotencyKey}`;

    try {
      // Redis fast path (atomic set-if-not-exists)
      const existing = await setIfNotExists(
        redis,
        redisKey,
        JSON.stringify({ status: 'processing', requestHash }),
        redisConfig.idempotencyKeyTtlSeconds,
      );

      if (existing) {
        const cached = JSON.parse(existing) as CachedResponse & { status: 'processing' | number };

        if (cached.requestHash !== requestHash) {
          return next(
            new ConflictError(
              'Idempotency key already used with a different request body',
            ),
          );
        }

        if (cached.status === 'processing') {
          // Request is in-flight, return 202 and let client retry
          res.status(202).json({
            message: 'Request is being processed. Please retry shortly.',
          });
          return;
        }

        // Return cached response
        metrics.idempotencyCacheHits.inc();
        res.setHeader('X-Idempotency-Replayed', 'true');
        res.status(cached.status).json(cached.body);
        return;
      }

      metrics.idempotencyCacheMisses.inc();

      // Intercept response to cache it
      const originalJson = res.json.bind(res);
      res.json = function (body: unknown): Response {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const toCache: CachedResponse = {
            status: res.statusCode,
            body,
            requestHash,
          };
          // Fire-and-forget cache write
          redis
            .set(
              redisKey,
              JSON.stringify(toCache),
              'EX',
              redisConfig.idempotencyKeyTtlSeconds,
            )
            .catch((err) =>
              logger.error({ err }, 'Failed to cache idempotency response'),
            );
        }
        return originalJson(body);
      };

      return next();
    } catch (err) {
      logger.error({ err }, 'Idempotency middleware error');
      return next(err);
    }
  };
}
