import { Router, Request, Response } from 'express';
import { metrics } from './metrics';

const router = Router();

// Prometheus scrape endpoint — excluded from auth middleware
router.get('/metrics', async (_req: Request, res: Response) => {
  res.setHeader('Content-Type', metrics.register.contentType);
  res.end(await metrics.register.metrics());
});

export { router as metricsRouter };
