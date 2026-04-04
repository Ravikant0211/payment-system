# Payment System Architecture

## Overview

A fault-tolerant, scalable payment system for e-commerce (~1,000 payments/day) built with Node.js + TypeScript. Stripe is the PSP. All internal service communication is asynchronous via Kafka.

## Key Design Decisions

### 1. Monolith with Clear Service Boundaries
Domain modules (`payment`, `ledger`, `webhook`, `reconciliation`) are structured as if they were microservices — each has its own repository, service, controller, and routes. Extracting a module into a standalone service later requires minimal refactoring.

### 2. Transactional Outbox Pattern (Exactly-Once Delivery)
Domain writes (e.g. payment row insert) and Kafka message inserts happen in the **same PostgreSQL transaction**. A background relay polls the `outbox` table and publishes to Kafka. Combined with Kafka's idempotent producer, this gives effectively-once delivery even through crashes.

```
HTTP Request → PaymentService → [DB Transaction: INSERT payment + INSERT outbox] → commit
                                                          ↓ (async, 500ms poll)
                                             OutboxRelay → Kafka → Consumers
```

### 3. Two-Layer Idempotency (No Double Charges)
- **Layer 1 — Redis** (fast): Atomic `SET NX EX` via Lua script. Returns cached response in <1ms on duplicate requests.
- **Layer 2 — PostgreSQL** (durable): `UNIQUE INDEX ON payments(merchant_id, idempotency_key)`. Survives Redis flushes and restarts.

### 4. Double-Entry Ledger
Every financial event creates two rows in `ledger_entries` sharing a `transaction_id`:

| Event           | Debit          | Credit         |
|-----------------|----------------|----------------|
| Payment received| RECEIVABLE     | REVENUE        |
| Refund issued   | REFUND_EXPENSE | RECEIVABLE     |
| Stripe fee      | STRIPE_FEE     | RECEIVABLE     |

A PostgreSQL trigger enforces that `SUM(debits) = SUM(credits)` per `transaction_id`.

### 5. Stripe Hosted Payment Page
Using `stripe.checkout.sessions.create()` — Stripe handles PCI-DSS compliance for card data. UPI and net banking are passed as `payment_method_types`. The customer is redirected to Stripe's URL; our DB is updated via webhook.

### 6. Retry with Exponential Backoff + Full Jitter
```typescript
delay = min(maxDelay, initialDelay * 2^attempt) * (1 ± jitter)
```
Full jitter (not equal jitter) distributes retries to prevent thundering-herd after outages. Kafka consumer retries are bounded; exhausted messages go to dead-letter topics.

### 7. Nightly Reconciliation
```
Internal DB (COMPLETED payments) ←compare→ Stripe Charges API (date range)
```
Produces a `reconciliation_reports` row with all mismatches as JSONB. Mismatches emit a Prometheus counter that triggers a Grafana alert.

### 8. Keyset Pagination
Payment lists use `(created_at DESC, id DESC)` cursor pagination — O(log n) at any dataset size, unlike offset pagination which degrades over time.

### 9. Money as Integer Minor Units
All amounts are `BIGINT` (cents, paise, etc.). No floating-point arithmetic anywhere. The `Money` value object enforces this invariant at compile time.

## Request Flow

```
Client
  │
  ▼
POST /v1/payments
  │  authenticate (Redis → PostgreSQL)
  │  idempotency (Redis Lua SET NX → PostgreSQL fallback)
  │
  ▼
PaymentService.createPayment()
  │
  ├─ [DB Transaction]
  │    INSERT payments (status=PENDING)
  │    stripe.checkout.sessions.create()   ← Stripe API call
  │    UPDATE payments (status=PROCESSING, stripeSessionId, checkoutUrl)
  │    INSERT payment_events               ← audit trail
  │    INSERT outbox                       ← will be relayed to Kafka
  │    COMMIT
  │
  ▼
Return { paymentId, checkoutUrl }
  │
  ▼
[Customer redirected to Stripe hosted page]
  │
  ▼
Stripe → POST /webhooks/stripe (checkout.session.completed)
  │  signature verification (express.raw + stripe.webhooks.constructEvent)
  │  deduplication (webhook_events table)
  │
  ├─ [DB Transaction]
  │    UPDATE payments (status=COMPLETED)
  │    INSERT payment_events
  │    INSERT ledger_entries × 2 (DEBIT RECEIVABLE, CREDIT REVENUE)
  │    INSERT outbox (PAYMENT_COMPLETED event)
  │    COMMIT
  │
  ▼
OutboxRelay → Kafka `payment.completed`
  │
  ▼
PaymentEventsConsumer → analytics, accounting, merchant webhooks
```

## Project Structure

```
src/
├── config/                    # Typed, validated environment config
├── common/
│   ├── errors/                # Typed error hierarchy (AppError subclasses)
│   ├── logger/                # Pino logger with AsyncLocalStorage tracing
│   ├── middleware/            # Auth, idempotency, validation, error handler
│   ├── tracing/               # TraceContext via AsyncLocalStorage
│   └── utils/                 # Money, retry, crypto (no side effects)
├── infrastructure/
│   ├── database/              # pg Pool, transaction helper, migrator
│   ├── redis/                 # ioredis client, Lua scripts
│   ├── kafka/                 # KafkaJS client, producer, consumer-manager
│   ├── stripe/                # Stripe SDK wrappers (checkout, webhooks, reconciliation)
│   ├── outbox/                # Transactional outbox repository + relay
│   └── scheduler/             # node-cron wrapper for nightly jobs
├── domains/
│   ├── payment/               # Payment aggregate: entity, repo, service, controller, routes
│   ├── ledger/                # Double-entry ledger: accounts, entries, service
│   ├── webhook/               # Stripe webhook processing + per-event handlers
│   └── reconciliation/        # Nightly Stripe ↔ DB comparison
├── kafka/
│   └── consumers/             # payment-events, dead-letter, reconciliation
├── metrics/                   # Prometheus metric definitions + /metrics endpoint
├── app.ts                     # Express app factory (DI, middleware, routing)
└── main.ts                    # Bootstrap: connect deps, start server, graceful shutdown
```

## Running Locally

```bash
# 1. Copy env
cp .env.example .env
# Fill in STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, API_KEY_SALT

# 2. Start infrastructure
docker-compose up -d postgres redis kafka

# 3. Install deps
npm install

# 4. Create a merchant and get an API key
ts-node scripts/generate-api-key.ts "My Store" "store@example.com"

# 5. Start the app (runs migrations automatically)
npm run dev

# 6. Create a payment
curl -X POST http://localhost:3000/v1/payments \
  -H "Authorization: Bearer <api-key>" \
  -H "Idempotency-Key: order-123" \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "order-123",
    "customerId": "cust-456",
    "amount": 4999,
    "currency": "USD",
    "paymentMethod": "CREDIT_CARD",
    "successUrl": "https://yourstore.com/success",
    "cancelUrl": "https://yourstore.com/cancel"
  }'

# 7. Forward Stripe webhooks locally
stripe listen --forward-to localhost:3000/webhooks/stripe

# 8. View dashboards
open http://localhost:3001  # Grafana (admin/admin)
open http://localhost:8080  # Kafka UI
open http://localhost:9090  # Prometheus
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection URL |
| `KAFKA_BROKERS` | Yes | Comma-separated broker addresses |
| `STRIPE_SECRET_KEY` | Yes | Stripe secret API key |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret |
| `API_KEY_SALT` | Yes | HMAC salt for hashing API keys |
| `PORT` | No | HTTP server port (default: 3000) |
| `LOG_LEVEL` | No | Pino log level (default: info) |
| `RECONCILIATION_CRON` | No | Cron schedule (default: `0 2 * * *`) |
| `OUTBOX_POLL_INTERVAL_MS` | No | Outbox relay interval (default: 500) |

## Alerting

Grafana alerts fire when:
- `reconciliation_mismatch_total` increases (payment discrepancy)
- `kafka_dlq_messages_total` increases (processing failures)
- `kafka_consumer_group_lag > 1000` for 5+ minutes
- `payment_failed_total` rate exceeds threshold

## Security

- **API keys**: HMAC-SHA256 hashed with salt; raw key never stored
- **Timing-safe comparison**: `crypto.timingSafeEqual` for key verification
- **Webhook verification**: Stripe signature checked before any JSON parsing
- **Rate limiting**: 200 req/min per IP
- **Helmet**: standard HTTP security headers
- **Input validation**: Zod schemas on all API inputs
- **No PCI scope**: Card data handled entirely by Stripe's hosted page
