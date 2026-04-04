import Redis from 'ioredis';
import { redisConfig } from '@/config';
import { logger } from '@/common/logger/logger';

let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis(redisConfig.url, {
      keyPrefix: redisConfig.keyPrefix,
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });

    client.on('connect', () => logger.info('Redis connected'));
    client.on('ready', () => logger.info('Redis ready'));
    client.on('error', (err) => logger.error({ err }, 'Redis error'));
    client.on('close', () => logger.warn('Redis connection closed'));
    client.on('reconnecting', () => logger.warn('Redis reconnecting'));
  }
  return client;
}

export async function closeRedisClient(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
    logger.info('Redis client closed');
  }
}
