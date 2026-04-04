/**
 * Application bootstrap.
 *
 * Startup order:
 * 1. Load and validate configuration (fail fast on missing env vars)
 * 2. Connect to PostgreSQL
 * 3. Run database migrations (with advisory lock for safe concurrent startup)
 * 4. Connect to Redis
 * 5. Connect Kafka producer
 * 6. Start outbox relay (polls DB → publishes to Kafka)
 * 7. Register Kafka consumers
 * 8. Start HTTP server
 * 9. Schedule cron jobs
 *
 * Graceful shutdown on SIGTERM/SIGINT:
 * - Stop accepting new HTTP connections
 * - Drain in-flight requests (30s timeout)
 * - Disconnect Kafka consumers (drain in-flight messages)
 * - Disconnect Kafka producer
 * - Stop outbox relay
 * - Close PostgreSQL pool
 * - Close Redis connection
 */

import 'dotenv/config';

// Validate all config on startup — throws if required env vars are missing
import './config';

import * as http from 'http';
import { getPool, closePool } from '@/infrastructure/database/pg-pool';
import { runMigrations } from '@/infrastructure/database/migrator';
import { getRedisClient, closeRedisClient } from '@/infrastructure/redis/redis-client';
import { getProducer, disconnectProducer } from '@/infrastructure/kafka/producer';
import { initConsumerManager, disconnectAllConsumers } from '@/infrastructure/kafka/consumer-manager';
import { OutboxRepository } from '@/infrastructure/outbox/outbox-repository';
import { OutboxRelay } from '@/infrastructure/outbox/outbox-relay';
import { registerPaymentEventsConsumer } from '@/kafka/consumers/payment-events.consumer';
import { registerPaymentRetryConsumer } from '@/kafka/consumers/payment-retry.consumer';
import { registerDeadLetterConsumer } from '@/kafka/consumers/dead-letter.consumer';
import { registerReconciliationConsumer } from '@/kafka/consumers/reconciliation.consumer';
import { setupScheduler } from '@/infrastructure/scheduler/cron';
import { createApp } from './app';
import { appConfig } from '@/config';
import { logger } from '@/common/logger/logger';

async function main(): Promise<void> {
  logger.info({ env: appConfig.nodeEnv }, 'Payment system starting up');

  // 1. Database
  const pool = getPool();
  await pool.query('SELECT 1'); // verify connectivity
  logger.info('PostgreSQL connected');

  // 2. Migrations
  await runMigrations(pool);

  // 3. Redis
  const redis = getRedisClient();
  await redis.ping();
  logger.info('Redis connected');

  // 4. Kafka producer
  await getProducer();

  // 5. Outbox relay
  const outboxRepo = new OutboxRepository(pool);
  const outboxRelay = new OutboxRelay(outboxRepo);
  outboxRelay.start();

  // 6. Kafka consumers
  // initConsumerManager must be called first — it provides the OutboxRepository
  // that consumer-manager uses to durably enqueue retries.
  initConsumerManager(pool);
  await registerPaymentEventsConsumer();
  await registerPaymentRetryConsumer();
  await registerDeadLetterConsumer(pool);
  await registerReconciliationConsumer();

  // 7. HTTP server
  const app = createApp(pool, redis);
  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(appConfig.port, () => {
      logger.info({ port: appConfig.port }, 'HTTP server listening');
      resolve();
    });
  });

  // 8. Cron jobs
  setupScheduler(pool);

  // ─── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down gracefully');

    // Stop accepting new connections
    await new Promise<void>((resolve, reject) =>
      server.close((err?: Error) => (err ? reject(err) : resolve())),
    );

    // Shutdown sequence (reverse of startup)
    outboxRelay.stop();
    await disconnectAllConsumers();
    await disconnectProducer();
    await closeRedisClient();
    await closePool();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT',  () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err: Error) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down');
    void shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ reason }, 'Unhandled promise rejection — shutting down');
    void shutdown('unhandledRejection');
  });
}

main().catch((err) => {
  // Logger may not be initialised yet — use console as fallback
  console.error('Fatal startup error:', err);
  process.exit(1);
});
