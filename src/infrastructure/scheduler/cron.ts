import cron from 'node-cron';
import { Pool } from 'pg';
import { ReconciliationService } from '@/domains/reconciliation/reconciliation.service';
import { StuckPaymentsChecker } from '@/domains/payment/stuck-payments-checker';
import { kafkaConfig } from '@/config';
import { logger } from '@/common/logger/logger';

/**
 * Schedules all recurring background jobs.
 *
 * Jobs:
 *  1. Nightly reconciliation — 2 AM UTC (configurable)
 *  2. Stuck payments checker — every 5 minutes
 *     Detects payments that have been PROCESSING too long and queries
 *     Stripe directly to determine their true status, recovering missed webhooks.
 */
export function setupScheduler(pool: Pool): void {
  scheduleReconciliation(pool);
  scheduleStuckPaymentsChecker(pool);
}

function scheduleReconciliation(pool: Pool): void {
  const schedule = kafkaConfig.reconciliationCron;

  if (!cron.validate(schedule)) {
    logger.error({ schedule }, 'Invalid cron schedule for reconciliation');
    return;
  }

  cron.schedule(
    schedule,
    async () => {
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      yesterday.setUTCHours(0, 0, 0, 0);

      logger.info(
        { date: yesterday.toISOString().split('T')[0] },
        'Scheduled reconciliation starting',
      );

      const service = new ReconciliationService(pool);
      await service.runReconciliation(yesterday).catch((err) => {
        logger.error({ err }, 'Scheduled reconciliation failed');
      });
    },
    { timezone: 'UTC' },
  );

  logger.info({ schedule }, 'Reconciliation cron job scheduled');
}

function scheduleStuckPaymentsChecker(pool: Pool): void {
  // Run every 5 minutes.
  // Card payments become eligible at 35 min; UPI/net banking at 3 hours.
  // Running every 5 minutes means we catch card payments within one polling interval
  // after their threshold and UPI payments promptly once the 3-hour window passes.
  const schedule = '*/5 * * * *';

  cron.schedule(
    schedule,
    async () => {
      const checker = new StuckPaymentsChecker(pool);
      await checker.run().catch((err) => {
        logger.error({ err }, 'Stuck payments checker run failed');
      });
    },
    { timezone: 'UTC' },
  );

  logger.info({ schedule }, 'Stuck payments checker scheduled');
}
