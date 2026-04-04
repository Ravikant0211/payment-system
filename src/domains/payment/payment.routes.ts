import { Router } from 'express';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentRepository } from './payment.repository';
import { OutboxRepository } from '@/infrastructure/outbox/outbox-repository';
import { createAuthMiddleware } from '@/common/middleware/authenticate';
import { idempotencyMiddleware } from '@/common/middleware/idempotency';

/**
 * Factory function for payment routes.
 * Dependencies are injected explicitly — no global singletons in route setup.
 */
export function createPaymentRouter(pool: Pool, redis: Redis): Router {
  const router = Router();

  const paymentRepo = new PaymentRepository(pool);
  const outboxRepo = new OutboxRepository(pool);
  const paymentService = new PaymentService(pool, paymentRepo, outboxRepo);
  const controller = new PaymentController(paymentService);

  const auth = createAuthMiddleware(pool, redis);
  const idempotency = idempotencyMiddleware(redis, pool);

  // All payment routes require authentication
  router.use(auth);

  router.post('/', idempotency, controller.createPayment);
  router.get('/', controller.listPayments);
  router.get('/:id', controller.getPayment);

  return router;
}
