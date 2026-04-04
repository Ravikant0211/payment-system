import { Router } from 'express';
import express from 'express';
import { Pool } from 'pg';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

export function createWebhookRouter(pool: Pool): Router {
  const router = Router();
  const webhookService = new WebhookService(pool);
  const controller = new WebhookController(webhookService);

  // IMPORTANT: express.raw() must be used here (not express.json())
  // so the raw Buffer is preserved for Stripe signature verification.
  router.post(
    '/stripe',
    express.raw({ type: 'application/json' }),
    controller.handleStripeWebhook,
  );

  return router;
}
