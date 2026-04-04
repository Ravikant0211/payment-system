import { Request, Response, NextFunction } from 'express';
import { WebhookService } from './webhook.service';
import { parseStripeWebhook } from '@/infrastructure/stripe/stripe-webhook-parser';
import { logger } from '@/common/logger/logger';

export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  /**
   * POST /webhooks/stripe
   *
   * Receives Stripe webhook events. The route MUST use express.raw() middleware
   * so the raw Buffer is available for signature verification.
   *
   * Returns 200 immediately after signature verification even if processing fails
   * (to prevent Stripe from disabling the webhook endpoint). Processing errors
   * are logged and retried via the outbox relay.
   */
  handleStripeWebhook = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const signature = req.headers['stripe-signature'] as string | undefined;
    if (!signature) {
      res.status(400).json({ error: 'Missing stripe-signature header' });
      return;
    }

    let event: ReturnType<typeof parseStripeWebhook>;
    try {
      event = parseStripeWebhook(req.body as Buffer, signature);
    } catch (err) {
      logger.warn({ err }, 'Stripe webhook signature verification failed');
      res.status(400).json({ error: 'Invalid webhook signature' });
      return;
    }

    // Acknowledge receipt to Stripe immediately — processing is async
    res.status(200).json({ received: true });

    // Process asynchronously; errors are logged (Stripe will retry on our 200)
    this.webhookService.processStripeEvent(event).catch((err) => {
      logger.error(
        { err, stripeEventId: event.id, eventType: event.type },
        'Webhook event processing failed',
      );
    });
  };
}
