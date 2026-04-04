# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start with hot-reload (nodemon + ts-node)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled output
npm run lint         # ESLint
npm run migrate      # Run pending DB migrations
npm run reconcile [YYYY-MM-DD]         # Manually trigger reconciliation
npm run generate-api-key <name> <email> # Create merchant + API key
```

**Infrastructure (required before running the app):**
```bash
docker-compose up -d postgres redis kafka
# Full stack including observability:
docker-compose up -d
```

**Stripe webhook forwarding (local dev):**
```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
```

## Architecture

### Layering (strict dependency direction: API → Domain → Infrastructure)

```
src/
├── infrastructure/   # I/O adapters — DB pool, Redis, Kafka, Stripe SDK wrappers, Outbox relay, Cron
├── common/           # Cross-cutting — errors, logger, tracing, middleware, retry, Money
├── domains/          # Business logic — payment, ledger, webhook, reconciliation
├── kafka/consumers/  # Kafka consumer registrations (payment-events, dead-letter, reconciliation)
├── metrics/          # Prometheus metric definitions + /metrics endpoint
├── app.ts            # Express factory — middleware stack, route mounting, DI wiring
└── main.ts           # Bootstrap — connects all deps in order, graceful shutdown
```

Domain modules never import from `infrastructure/` directly — dependencies are injected via constructors.

### Domain pattern (same structure in every domain)

Each domain under `src/domains/<name>/` contains: `*.entity.ts` → `*.repository.ts` → `*.service.ts` → `*.controller.ts` → `*.routes.ts`. Routes are factory functions (`createPaymentRouter(pool, redis)`) that wire up dependencies — no global singletons in route setup.

### Critical flow: creating a payment

`POST /v1/payments` → `PaymentService.createPayment()` opens a DB transaction, inserts a `payments` row + calls `stripe.checkout.sessions.create()` + inserts an `outbox` row, all in the same commit. The **OutboxRelay** polls `outbox` every 500ms and publishes to Kafka. This is the Transactional Outbox Pattern — it guarantees at-least-once Kafka delivery even through crashes without dual-write risk.

### Critical flow: completing a payment

Stripe → `POST /webhooks/stripe` → `WebhookService.processStripeEvent()` runs everything in a single DB transaction: deduplication check on `webhook_events.stripe_event_id`, payment status update, two `ledger_entries` rows (double-entry), outbox insert for `PAYMENT_COMPLETED`. The DB trigger on `ledger_entries` enforces `SUM(debits) = SUM(credits)` per `transaction_id` — imbalanced entries raise a Postgres exception.

### Idempotency (two layers)

1. **Redis** (fast path): Lua `SET NX EX` in `src/infrastructure/redis/lua-scripts.ts` — atomic, no TOCTOU race.
2. **PostgreSQL** (durable fallback): `UNIQUE INDEX ON payments(merchant_id, idempotency_key)` — survives Redis restarts.

Both layers are checked in `src/common/middleware/idempotency.ts` which intercepts `POST /v1/payments`.

### Kafka retry + DLQ

`src/infrastructure/kafka/consumer-manager.ts` wraps every consumer handler with `retryWithBackoff` (exponential backoff, configurable attempts). On exhaustion it publishes to `<topic>.dlq`, commits the original offset, and the `dead-letter.consumer.ts` stores the message in `dead_letter_messages` table for operator review.

### Retry strategy (three layers)

| Layer | Where | Mechanism |
|---|---|---|
| Stripe API | `stripe-checkout.ts` | `retryWithBackoff` (3 attempts, 500ms–4s, jitter); only retries network errors, 429, 5xx — never 4xx |
| Outbox relay | `outbox-relay.ts` | Inner `retryWithBackoff` (2 in-sweep attempts); outer sweep retry count persisted in DB up to `OUTBOX_MAX_RETRIES` |
| Kafka consumers | `consumer-manager.ts` | `retryWithBackoff` per message (configurable `maxRetries`); exhausted → DLQ topic → `dead-letter.consumer.ts` → `dead_letter_messages` table |

### Payment processing delays

Payments land in `PROCESSING` when the Stripe checkout session is created. They leave `PROCESSING` via Stripe webhooks. If a webhook is missed or delayed (common with UPI/net banking bank async processing), the `StuckPaymentsChecker` (`src/domains/payment/stuck-payments-checker.ts`) runs every 5 minutes:

1. Finds payments in `PROCESSING` older than their method-specific threshold (35 min for cards, 3 hours for UPI/net banking).
2. Calls `retrieveCheckoutSession()` to query Stripe's current status.
3. If `complete` → manually transitions to `COMPLETED` + writes ledger + emits Kafka event (missed webhook recovery).
4. If `expired` or session expiry has passed → transitions to `FAILED` + emits `PAYMENT_FAILED`.
5. If still `open` and not yet expired → leaves unchanged, re-evaluates on next run.

All transitions are wrapped in a DB transaction (status + event + outbox in one commit).

### Reconciliation

`ReconciliationService.runReconciliation()` streams Stripe charges via an async generator (`listChargesForDateRange`), builds two maps, and produces three mismatch categories: `MISSING_IN_DB`, `MISSING_IN_STRIPE`, `AMOUNT_MISMATCH`. Results are stored in `reconciliation_reports` as JSONB. Each mismatch increments the `reconciliation_mismatch_total` Prometheus counter, which drives a Grafana alert.

## Key Conventions

- **All monetary amounts are `BIGINT` minor units** (cents, paise). Never use floats. Use the `Money` value object in `src/common/utils/money.ts` for arithmetic.
- **Errors**: throw subclasses of `AppError` from `src/common/errors/index.ts`. The centralised `errorHandler` middleware maps them to HTTP responses.
- **Logging**: import `logger` from `src/common/logger/logger.ts`. Every log line automatically carries `traceId`/`correlationId` via `AsyncLocalStorage` — no need to pass them explicitly.
- **Config**: all env vars are validated at startup in `src/config/`. Add new vars to the appropriate config file and `.env.example`. The app will crash with a clear message if a required var is missing.
- **Migrations**: add a new numbered `.sql` file to `migrations/`. They run in filename order with a Postgres advisory lock (safe for concurrent deployments). Never modify existing migration files.
- **Stripe webhook route**: must use `express.raw({ type: 'application/json' })` — the raw Buffer is required for signature verification. This is already set up in `src/domains/webhook/webhook.routes.ts`.
