import express, { Application, Request, Response } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { Pool } from 'pg';
import { Redis } from 'ioredis';

import { requestLogger } from '@/common/middleware/request-logger';
import { errorHandler } from '@/common/middleware/error-handler';
import { createPaymentRouter } from '@/domains/payment/payment.routes';
import { createWebhookRouter } from '@/domains/webhook/webhook.routes';
import { createReconciliationRouter } from '@/domains/reconciliation/reconciliation.routes';
import { createAdminRouter } from '@/domains/admin/admin.routes';
import { metricsRouter } from '@/metrics/metrics.router';
import { LedgerRepository } from '@/domains/ledger/ledger.repository';

/**
 * Express application factory.
 * All dependencies are injected — no global state, fully testable.
 */
export function createApp(pool: Pool, redis: Redis): Application {
  const app = express();

  // ─── Security ─────────────────────────────────────────────────────────────
  app.use(helmet());
  app.disable('x-powered-by');

  // ─── Rate limiting ─────────────────────────────────────────────────────────
  const limiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute
    max: 200,               // 200 requests per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
  });
  app.use(limiter);

  // ─── Request parsing ────────────────────────────────────────────────────────
  // Note: /webhooks/stripe uses express.raw() — registered there before app.use(json)
  app.use(express.json({ limit: '1mb' }));
  app.use(compression());

  // ─── Observability ──────────────────────────────────────────────────────────
  app.use(requestLogger);

  // ─── Health check (no auth required) ───────────────────────────────────────
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await pool.query('SELECT 1');
      await redis.ping();
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded' });
    }
  });

  // ─── Metrics (Prometheus, no auth — internal network only) ─────────────────
  app.use(metricsRouter);

  // ─── Webhooks (no API key auth — Stripe signature is the auth) ─────────────
  app.use('/webhooks', createWebhookRouter(pool));

  // ─── API routes (all require API key auth) ─────────────────────────────────
  app.use('/v1/payments', createPaymentRouter(pool, redis));
  app.use('/v1/reconciliation', createReconciliationRouter(pool, redis));

  // ─── Admin routes (internal only — must be behind VPN/private network) ──────
  app.use('/admin', createAdminRouter(pool));

  // ─── Ledger read endpoints ──────────────────────────────────────────────────
  // Inline for brevity; a full LedgerController would follow the same pattern
  const ledgerRepo = new LedgerRepository(pool);
  app.get(
    '/v1/ledger/accounts/:code/balance',
    async (req: Request, res: Response, next) => {
      try {
        const { code } = req.params as { code: string };
        const currency = (req.query['currency'] as string | undefined) ?? 'USD';
        const balance = await ledgerRepo.getAccountBalance(code, currency);
        res.json({ data: balance });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    '/v1/ledger/payments/:paymentId/entries',
    async (req: Request, res: Response, next) => {
      try {
        const { paymentId } = req.params as { paymentId: string };
        const entries = await ledgerRepo.getEntriesForPayment(paymentId);
        res.json({ data: entries });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── 404 handler ────────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // ─── Centralised error handler (MUST be last) ───────────────────────────────
  app.use(errorHandler);

  return app;
}
