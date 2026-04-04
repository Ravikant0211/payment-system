import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { ReconciliationService } from './reconciliation.service';
import { createAuthMiddleware } from '@/common/middleware/authenticate';
import { NotFoundError } from '@/common/errors';

export function createReconciliationRouter(pool: Pool, redis: Redis): Router {
  const router = Router();
  const reconciliationService = new ReconciliationService(pool);
  const auth = createAuthMiddleware(pool, redis);

  router.use(auth);

  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const reports = await reconciliationService.listReports();
      res.json({ data: reports });
    } catch (err) {
      next(err);
    }
  });

  router.get(
    '/:date',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { date } = req.params as { date: string };
        const report = await reconciliationService.getReport(date);
        if (!report) throw new NotFoundError('ReconciliationReport', date);
        res.json({ data: report });
      } catch (err) {
        next(err);
      }
    },
  );

  // Manual trigger endpoint (useful for backfilling / debugging)
  router.post(
    '/trigger',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const dateStr = (req.body as { date?: string }).date;
        const targetDate = dateStr ? new Date(dateStr) : new Date();

        // Fire and forget — reconciliation can be slow
        reconciliationService.runReconciliation(targetDate).catch((err) => {
          const { logger } = require('@/common/logger/logger');
          logger.error({ err }, 'Manual reconciliation run failed');
        });

        res.status(202).json({
          message: 'Reconciliation job started',
          date: targetDate.toISOString().split('T')[0],
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
