import Stripe from 'stripe';
import { Pool } from 'pg';
import { WebhookEventRepository } from './webhook-event.repository';
import { PaymentRepository } from '@/domains/payment/payment.repository';
import { LedgerService } from '@/domains/ledger/ledger.service';
import { LedgerRepository } from '@/domains/ledger/ledger.repository';
import { OutboxRepository } from '@/infrastructure/outbox/outbox-repository';
import { withTransaction } from '@/infrastructure/database/transaction';
import {
  isCheckoutSessionCompleted,
  isCheckoutSessionExpired,
  isPaymentIntentFailed,
  isChargeRefunded,
} from '@/infrastructure/stripe/stripe-webhook-parser';
import { handleCheckoutSessionCompleted } from './handlers/checkout-session-completed.handler';
import { handleCheckoutSessionExpired } from './handlers/checkout-session-expired.handler';
import { handlePaymentIntentFailed } from './handlers/payment-intent-failed.handler';
import { handleChargeRefunded } from './handlers/charge-refunded.handler';
import { logger } from '@/common/logger/logger';

/**
 * WebhookService: processes Stripe webhook events.
 *
 * Implements the idempotent event handler pattern:
 * 1. All writes happen in a single DB transaction.
 * 2. Events are deduplicated by Stripe event ID (stored in webhook_events table).
 * 3. If an event was already processed, it is acknowledged without re-processing.
 *
 * Follows Open/Closed Principle: adding a new event type means adding a new handler
 * function, not modifying this service.
 */
export class WebhookService {
  private readonly paymentRepo: PaymentRepository;
  private readonly ledgerService: LedgerService;
  private readonly outboxRepo: OutboxRepository;
  private readonly webhookEventRepo: WebhookEventRepository;

  constructor(private readonly pool: Pool) {
    this.paymentRepo = new PaymentRepository(pool);
    this.ledgerService = new LedgerService(new LedgerRepository(pool));
    this.outboxRepo = new OutboxRepository(pool);
    this.webhookEventRepo = new WebhookEventRepository(pool);
  }

  async processStripeEvent(event: Stripe.Event): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      // Step 1: Deduplication — check if already processed
      const existing = await this.webhookEventRepo.findByStripeEventId(
        client,
        event.id,
      );
      if (existing?.processed) {
        logger.info(
          { stripeEventId: event.id, eventType: event.type },
          'Webhook event already processed, skipping',
        );
        return;
      }

      // Step 2: Insert webhook event record (processed = false)
      const webhookEventId = existing?.id ?? await this.webhookEventRepo.create(
        client,
        event.id,
        event.type,
        event.data.object,
      );

      try {
        // Step 3: Dispatch to the appropriate handler
        await this.dispatch(client, event);

        // Step 4: Mark as processed
        await this.webhookEventRepo.markProcessed(client, webhookEventId);

        logger.info(
          { stripeEventId: event.id, eventType: event.type },
          'Webhook event processed successfully',
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.webhookEventRepo.markFailed(client, webhookEventId, errMsg);
        throw err;
      }
    });
  }

  private async dispatch(
    client: Parameters<typeof withTransaction>[1] extends (c: infer C) => unknown ? C : never,
    event: Stripe.Event,
  ): Promise<void> {
    if (isCheckoutSessionCompleted(event)) {
      await handleCheckoutSessionCompleted(
        client,
        event.data.object,
        this.paymentRepo,
        this.ledgerService,
        this.outboxRepo,
      );
    } else if (isCheckoutSessionExpired(event)) {
      await handleCheckoutSessionExpired(
        client,
        event.data.object,
        this.paymentRepo,
        this.outboxRepo,
      );
    } else if (isPaymentIntentFailed(event)) {
      await handlePaymentIntentFailed(
        client,
        event.data.object,
        this.paymentRepo,
        this.outboxRepo,
      );
    } else if (isChargeRefunded(event)) {
      await handleChargeRefunded(
        client,
        event.data.object,
        this.paymentRepo,
        this.ledgerService,
        this.outboxRepo,
      );
    } else {
      // Unknown event type — acknowledge without processing (200 to Stripe)
      logger.debug({ eventType: event.type }, 'Unhandled Stripe event type');
    }
  }
}
