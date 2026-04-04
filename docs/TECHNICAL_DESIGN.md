# Payment System — Technical Design Document

> A production-grade, fault-tolerant payment processing system built for an e-commerce business. Supports approximately 1,000 payments per day across credit cards, debit cards, UPI, and net banking via Stripe as the payment service provider.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [Architecture Overview](#3-architecture-overview)
4. [How a Payment Works — End to End](#4-how-a-payment-works--end-to-end)
5. [Core Design Patterns](#5-core-design-patterns)
   - [Transactional Outbox Pattern](#51-transactional-outbox-pattern)
   - [Two-Layer Idempotency](#52-two-layer-idempotency)
   - [Double-Entry Ledger](#53-double-entry-ledger)
   - [Kafka Retry and Dead-Letter Queue](#54-kafka-retry-and-dead-letter-queue)
   - [Stuck Payments Recovery](#55-stuck-payments-recovery)
6. [Domain Breakdown](#6-domain-breakdown)
7. [Infrastructure Components](#7-infrastructure-components)
8. [Database Schema](#8-database-schema)
9. [API Reference](#9-api-reference)
10. [Observability](#10-observability)
11. [Security](#11-security)
12. [Running the System](#12-running-the-system)
13. [Operational Playbook](#13-operational-playbook)

---

## 1. System Overview

This system handles the full lifecycle of a payment: creation, processing via Stripe's hosted checkout page, completion (or failure), refunds, and nightly financial reconciliation between internal records and Stripe. It is built as a single deployable Node.js service with clearly separated domain boundaries.

### What the system does

- **Creates payments** on behalf of merchants. Each call to `POST /v1/payments` opens a Stripe Checkout Session and returns a URL the customer visits to complete their purchase. The system never handles raw card numbers — Stripe's hosted page takes PCI scope off the table.
- **Processes webhook events** from Stripe. When a customer pays, Stripe sends a `checkout.session.completed` event. The system verifies the signature, deduplicates, records the transaction in a double-entry ledger, and publishes a Kafka event — all in a single atomic database transaction.
- **Handles payment delays**. UPI and net banking payments are asynchronous; a customer may take hours to complete a bank redirect. A background job polls Stripe every 5 minutes and recovers payments whose webhooks were missed or delayed.
- **Reconciles nightly**. A cron job runs at 2 AM and compares every completed internal payment against Stripe's charge history. Discrepancies trigger a Slack alert with a full mismatch report.
- **Manages failures**. Every Kafka consumer failure is routed through a durable retry queue (1 min → 5 min → 30 min delays, persisted in the database) before being promoted to a dead-letter queue. Operators can inspect, replay, or discard dead-letter messages via admin endpoints.

### What the system does not do

- It does not render any UI — it is a pure backend API.
- It does not handle subscription billing or recurring charges.
- It does not manage merchant onboarding beyond API key generation.

---

## 2. Technology Stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js 20 | Long-term support, strong async I/O model |
| Language | TypeScript 5 (strict mode) | Type safety, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` |
| HTTP framework | Express 4 | Minimal, well-understood, easy to test |
| Database | PostgreSQL 16 | ACID transactions, JSONB, advisory locks, triggers |
| Cache / idempotency | Redis 7 | Atomic Lua scripts, sub-millisecond latency |
| Message bus | Apache Kafka (KRaft, no Zookeeper) | At-least-once delivery, durable ordered log, consumer groups |
| Payment provider | Stripe | Hosted checkout UI, webhooks, charge listing API |
| Schema validation | Zod | Runtime validation with TypeScript type inference |
| Logging | Pino | Structured JSON logs, low overhead |
| Metrics | prom-client (Prometheus) | Industry standard, Grafana dashboards |
| Alerting | Slack incoming webhooks | Ops notifications for DLQ events and reconciliation failures |

---

## 3. Architecture Overview

The system is a **monolith with clean domain boundaries**. All business logic runs in a single process, but the code is structured so that domains never import from each other and all I/O adapters are injected rather than imported directly.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    External Clients                                 │
│           Browser/App ─── Merchant Backend ─── Stripe              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP
┌──────────────────────────────▼──────────────────────────────────────┐
│                     Payment System (Node.js)                        │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Express HTTP Server :3000                                   │   │
│  │  /v1/payments · /webhooks/stripe · /admin · /metrics         │   │
│  └─────────────────────────────┬────────────────────────────────┘   │
│                                │                                    │
│  ┌─────────────┐  ┌────────────▼───────────┐  ┌─────────────────┐  │
│  │   Domains   │  │  Common / Shared       │  │  Infrastructure │  │
│  │  ─────────  │  │  ───────────────────   │  │  ─────────────  │  │
│  │  payment    │  │  errors / logger       │  │  pg-pool        │  │
│  │  webhook    │  │  middleware            │  │  redis-client   │  │
│  │  ledger     │  │  Money · retry         │  │  kafka producer │  │
│  │  recon      │  │  tracing               │  │  stripe SDK     │  │
│  │  admin      │  └────────────────────────┘  │  outbox-relay   │  │
│  └─────────────┘                              │  cron           │  │
│                                               │  slack-alerter  │  │
│  ┌─────────────────────────────────────────┐  └─────────────────┘  │
│  │  Kafka Consumers                        │                       │
│  │  payment-events · payment-retry         │                       │
│  │  dead-letter · reconciliation           │                       │
│  └─────────────────────────────────────────┘                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
        ┌──────────┬───────────┼───────────┬──────────┐
        ▼          ▼           ▼           ▼          ▼
   PostgreSQL   Redis       Kafka       Stripe      Slack
```

### Startup order (`src/main.ts`)

The application boots in a fixed sequence to ensure every dependency is healthy before it is used:

1. Validate all environment variables (crash immediately if any are missing)
2. Connect to PostgreSQL and verify with `SELECT 1`
3. Run database migrations (with a Postgres advisory lock — safe for concurrent deployments)
4. Connect to Redis and verify with `PING`
5. Connect the Kafka producer
6. Start the Outbox Relay
7. Register all four Kafka consumers
8. Start the HTTP server
9. Schedule cron jobs

Graceful shutdown on `SIGTERM`/`SIGINT` drains HTTP connections (30s), then disconnects consumers, producer, Redis, and PostgreSQL in reverse order.

---

## 4. How a Payment Works — End to End

This section walks through the complete lifecycle of a single payment from creation to completion.

### Step 1: Merchant creates a payment

The merchant backend calls:

```
POST /v1/payments
Authorization: Bearer <api_key>
Idempotency-Key: <unique-uuid>

{
  "orderId": "order-123",
  "customerId": "cust-456",
  "amount": 50000,
  "currency": "INR",
  "paymentMethod": "UPI",
  "successUrl": "https://shop.example.com/order/123/success",
  "cancelUrl": "https://shop.example.com/order/123/cancel"
}
```

Note: `amount` is always in **minor units** — 50000 paise = ₹500.00. The system never uses floating-point numbers for money.

### Step 2: Idempotency check

The request first passes through the idempotency middleware. It runs a Lua script against Redis that atomically checks whether this `(merchantId, Idempotency-Key)` pair has been seen before. If it has, the cached response is returned immediately — no database access, no Stripe call.

### Step 3: Authentication

The API key in the `Authorization` header is hashed with HMAC-SHA256 and looked up in the `merchants` table. The result is cached in Redis for 10 minutes so repeated requests don't hit the database.

### Step 4: Atomic payment creation

`PaymentService.createPayment()` opens a single database transaction and does three things inside it:

1. Inserts a `payments` row with `status = PENDING`.
2. Calls `stripe.checkout.sessions.create()` (with retry logic — see §5.1) and gets back a `checkoutUrl`.
3. Updates the `payments` row to `status = PROCESSING` with the Stripe session ID.
4. Inserts an `outbox` row for the `PAYMENT_INITIATED` Kafka event.

All four writes either commit together or roll back together. If Stripe's API call fails, the payment row is rolled back — there is no orphaned database record.

The response to the merchant is:

```json
{
  "data": {
    "paymentId": "pay_uuid",
    "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_xxx..."
  }
}
```

### Step 5: Customer pays on Stripe

The merchant redirects the customer to the `checkoutUrl`. Stripe's hosted page handles all card entry, UPI QR code generation, or net banking redirect. The system is never involved during this step.

### Step 6: Outbox Relay publishes to Kafka

Meanwhile, the `OutboxRelay` polls the `outbox` table every 500ms. It picks up the `PAYMENT_INITIATED` row and publishes it to the `payment.initiated` Kafka topic. Once published successfully, the row is marked `SENT`. This is the Transactional Outbox Pattern — it guarantees at-least-once Kafka delivery even through process crashes.

### Step 7: Stripe sends a webhook

When the customer completes payment, Stripe calls `POST /webhooks/stripe` with a `checkout.session.completed` event.

The `WebhookController` verifies the Stripe signature on the **raw request body** (not the parsed JSON — signature verification requires the exact bytes Stripe sent). It returns `200 OK` immediately and processes the event asynchronously.

### Step 8: Atomic webhook processing

`WebhookService.processStripeEvent()` opens a new database transaction:

1. Checks `webhook_events` for this `stripe_event_id`. If already processed, silently exits (idempotent).
2. Inserts a `webhook_events` row with `processed = false`.
3. Dispatches to the appropriate handler based on event type.
4. The `checkout.session.completed` handler:
   - Updates `payments` to `status = COMPLETED`
   - Creates two `ledger_entries` rows (one DEBIT, one CREDIT — see §5.3)
   - Inserts an `outbox` row for `PAYMENT_COMPLETED`
5. Marks `webhook_events.processed = true`.
6. Commits.

### Step 9: Downstream processing via Kafka

The `OutboxRelay` picks up the `PAYMENT_COMPLETED` outbox row and publishes it to Kafka. The `payment-events` consumer receives it and increments Prometheus counters, triggers analytics, and any other downstream processing.

---

## 5. Core Design Patterns

### 5.1 Transactional Outbox Pattern

**The problem**: publishing to Kafka and writing to a database are two separate operations. If the process crashes between them, one of the two systems ends up in a different state — a dual-write problem. You cannot use a distributed transaction between a relational database and Kafka.

**The solution**: never publish to Kafka directly from a service method. Instead, insert a row into an `outbox` table *inside the same database transaction* as the business data. A separate background process (the `OutboxRelay`) reads pending outbox rows and publishes them.

```
Service method:
  BEGIN TRANSACTION
    INSERT payments row
    INSERT outbox row   ← same commit
  COMMIT

OutboxRelay (separate process loop):
  SELECT * FROM outbox WHERE status = 'PENDING' FOR UPDATE SKIP LOCKED
  → publish to Kafka
  → UPDATE outbox SET status = 'SENT'
```

If the process crashes after `COMMIT` but before Kafka publish, the outbox row is still `PENDING` on restart and the relay will pick it up. There is no scenario in which a payment exists in the database but a Kafka event is never published.

**`FOR UPDATE SKIP LOCKED`** allows multiple OutboxRelay instances to run in parallel for horizontal scaling — each instance claims different rows without blocking.

The relay wraps each `sendMessage()` call in `retryWithBackoff` (2 inner attempts, 600ms–2s) to handle transient Kafka broker blips within a single sweep. For persistent failures, an outer retry counter in the database gates how many sweeps a row can survive before being marked `FAILED`.

### 5.2 Two-Layer Idempotency

The system prevents duplicate charges through two independent layers. This matters because merchants may retry a failed network call, and Stripe may deliver webhook events more than once.

**Layer 1 — Redis (fast path, ~1ms)**

The `idempotency` middleware runs a Lua script that atomically checks whether the key exists and sets it in a single operation:

```lua
local existing = redis.call('GET', KEYS[1])
if existing then return existing end
redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', 86400)
return nil
```

Why Lua? A plain `GET` followed by a `SET` has a race window — two concurrent requests could both read `nil` and both proceed. The Lua script executes atomically, so only one will win.

**Layer 2 — PostgreSQL (durable fallback)**

The `payments` table has a unique constraint:

```sql
UNIQUE INDEX ON payments(merchant_id, idempotency_key)
```

If Redis is restarted, evicts the key under memory pressure, or the process crashes between processing and caching the response, the database will still reject a duplicate `INSERT` with a constraint violation. The two layers together mean there is no single point of failure for duplicate prevention.

**Webhook deduplication** works the same way — the `webhook_events` table has `UNIQUE (stripe_event_id)`. Stripe delivers webhooks at-least-once; the unique constraint makes processing exactly-once.

### 5.3 Double-Entry Ledger

Every payment event is recorded as a pair of accounting entries that must balance. This creates an auditable financial record and makes it impossible to create money or lose track of it.

**Chart of accounts:**

| Code | Type | Normal Balance | Meaning |
|---|---|---|---|
| `RECEIVABLE` | Asset | Debit | What customers owe us |
| `REVENUE` | Revenue | Credit | Income earned |
| `REFUND_EXPENSE` | Expense | Debit | Refunds paid out |
| `STRIPE_FEE` | Expense | Debit | Processing fees paid to Stripe |

**Payment received** (customer pays ₹500):
```
DEBIT  RECEIVABLE  ₹500   ← asset increases (customer owes us)
CREDIT REVENUE     ₹500   ← income recognised
```

**Refund issued** (merchant refunds ₹500):
```
DEBIT  REFUND_EXPENSE  ₹500   ← expense increases (we're paying out)
CREDIT RECEIVABLE      ₹500   ← asset decreases (customer no longer owes us)
```

**Database enforcement**: a PostgreSQL trigger on `ledger_entries` fires `AFTER INSERT` and checks that `SUM(debit amounts) = SUM(credit amounts)` for the same `transaction_id`. An imbalanced insert raises a Postgres exception and rolls back the entire transaction. The invariant is enforced at the database level — no code bug can create an unbalanced ledger.

### 5.4 Kafka Retry and Dead-Letter Queue

Every Kafka consumer uses a three-path routing strategy implemented in `consumer-manager.ts`:

```
Message arrives
    │
    ▼
Handler runs
    │
    ├─ Success ──────────────────────────────────▶ commitOffset
    │
    ├─ RetryableError (transient failure)
    │     ├─ Retries remaining ────────────────▶ Schedule in outbox
    │     │                                      (1 min → 5 min → 30 min)
    │     │                                      commitOffset (partition freed)
    │     └─ Exhausted ───────────────────────▶ Dead-Letter Queue
    │
    └─ Any other Error (non-retryable) ─────────▶ Dead-Letter Queue
```

**Why is the retry queue durable?**

The naive approach — `await sleep(delay)` inside the consumer — has two fatal problems:
1. The partition is blocked for the entire delay (up to 30 minutes), preventing all other messages from being processed.
2. If the process restarts during the delay, the retry is silently lost.

Instead, a retry is written to the `outbox` table (with a `scheduled_at` timestamp in the future) *before* committing the Kafka offset. The partition is immediately freed. The OutboxRelay waits until `scheduled_at <= NOW()` and then publishes to `payment.retry`. The retry consumer re-runs the same handler function. If it fails again, the retry count increments and it loops back — until `maxRetries` is exhausted, at which point the message goes to the DLQ.

**Handler contract:**

```typescript
// Throw this for transient failures — message will be retried
throw new RetryableError('Analytics service unavailable', originalError);

// Throw anything else for permanent failures — message goes directly to DLQ
throw new Error('Invalid payment payload — missing paymentId');
```

**Dead-letter consumer**: reads from all `*.dlq` topics, persists each message to the `dead_letter_messages` table, fires a critical Slack alert, and increments a Prometheus counter. Operators act via `/admin/dlq`.

**Retry schedule:**

| Attempt | Delay |
|---------|-------|
| 1st | +1 minute |
| 2nd | +5 minutes |
| 3rd | +30 minutes |
| After 3rd | → Dead-Letter Queue |

### 5.5 Stuck Payments Recovery

UPI and net banking payments are genuinely asynchronous. A customer may leave the bank redirect page open for hours. Stripe webhooks for these methods often arrive long after the checkout session was created — and sometimes not at all if the webhook delivery fails.

The `StuckPaymentsChecker` runs every 5 minutes and detects payments that have been in `PROCESSING` status longer than their method-specific threshold:

| Payment Method | Threshold | Rationale |
|---|---|---|
| Credit Card | 35 minutes | Stripe session expires after 30 min; +5 min for webhook delivery |
| Debit Card | 35 minutes | Same as credit card |
| UPI | 3 hours | Bank processing is genuinely async |
| Net Banking | 3 hours | Bank redirect may take time |

For each stuck payment, the checker calls `stripe.checkout.sessions.retrieve()` and acts on the result:

- **`complete`** — the payment succeeded but the webhook was missed. The checker manually transitions the payment to `COMPLETED`, writes the ledger entries, and inserts an outbox row (same transaction as the original webhook handler would have done). The event record shows `actor = "stuck_payments_checker"` so the recovery is visible in the audit trail.
- **`expired`** — the session expired without payment. Mark as `FAILED`.
- **`open` with expired session expiry timestamp** — session is open but time has passed. Mark as `FAILED`.
- **`open` with valid session expiry** — the customer may still be completing the payment. Leave unchanged and re-evaluate on the next run.
- **Stripe API error** — do not mark as failed; Stripe may be temporarily unavailable. Re-evaluate next run.

---

## 6. Domain Breakdown

The system is divided into five domains under `src/domains/`. Each domain follows the same structure: `entity → repository → service → controller → routes`.

### Payment domain (`src/domains/payment/`)

The core domain. Manages the payment lifecycle from creation through completion.

**`PaymentService`** is the single entry point for all payment mutations. It orchestrates:
- DB-layer idempotency check (belt-and-suspenders beyond the Redis middleware)
- Stripe Checkout Session creation (with retry)
- Atomic DB commit (payment + outbox)
- Event recording for audit trail
- Prometheus metric emission

**`PaymentRepository`** handles all SQL. Notable methods:
- `create()` — inserts a new payment inside a provided transaction client
- `updateStatus()` — updates status and Stripe fields, using `COALESCE` to avoid overwriting existing values with null
- `list()` — keyset (cursor) pagination on `(created_at DESC, id DESC)`, O(log n) regardless of dataset size
- `findStuckPayments()` — used by `StuckPaymentsChecker`
- `findCompletedForDate()` — used by `ReconciliationService`

**`StuckPaymentsChecker`** — see §5.5.

**Payment status lifecycle:**

```
PENDING → PROCESSING → COMPLETED
                    → FAILED
                    → EXPIRED
                    → REFUNDED
                    → CANCELLED
```

### Webhook domain (`src/domains/webhook/`)

Handles all inbound Stripe webhook events. The design follows the Open/Closed Principle: adding a new event type means adding a new handler file, not modifying `WebhookService`.

**`WebhookController`**: verifies the Stripe signature on the raw request buffer, returns 200 immediately (Stripe has a 30-second delivery timeout), then dispatches async processing.

**`WebhookService`**: wraps everything in a single database transaction. Handles deduplication, dispatches to the correct handler, marks the event processed.

**Handlers** (`src/domains/webhook/handlers/`):
- `checkout-session-completed.handler.ts` — transitions to `COMPLETED`, writes ledger, inserts outbox
- `checkout-session-expired.handler.ts` — transitions to `EXPIRED`, inserts outbox
- `payment-intent-failed.handler.ts` — transitions to `FAILED` with decline reason, inserts outbox
- `charge-refunded.handler.ts` — transitions to `REFUNDED`, writes reverse ledger entries, inserts outbox

### Ledger domain (`src/domains/ledger/`)

Implements double-entry bookkeeping — see §5.3 for the full explanation.

**`LedgerService`** provides three operations:
- `recordPaymentReceived(paymentId, amount, currency)` — DEBIT RECEIVABLE / CREDIT REVENUE
- `recordRefund(paymentId, amount, currency)` — DEBIT REFUND_EXPENSE / CREDIT RECEIVABLE
- `recordStripeFee(paymentId, feeAmount, currency)` — DEBIT STRIPE_FEE / CREDIT RECEIVABLE

Each generates a `transactionId` UUID shared by the two entries, which the database trigger uses to verify balance.

**`LedgerRepository`** exposes:
- `insertEntry()` — always takes a transaction `PoolClient` (called inside webhook transactions)
- `getAccountBalance()` — returns current balance for an account code and currency
- `getEntriesForPayment()` — returns all ledger lines for a given payment (used by the admin state dump endpoint)

### Reconciliation domain (`src/domains/reconciliation/`)

Compares internal records against Stripe nightly to detect financial discrepancies.

**`ReconciliationService.runReconciliation(date)`**:
1. Fetches all `COMPLETED` payments for the target date from the database.
2. Streams all Stripe charges for the same date range via an async generator — memory-efficient, handles any volume by fetching one page at a time.
3. Builds two hash maps keyed by `payment_intent_id`.
4. Produces three mismatch categories: `MISSING_IN_DB`, `MISSING_IN_STRIPE`, `AMOUNT_MISMATCH`.
5. Persists the full report (including all mismatch details as JSONB) to `reconciliation_reports`.
6. Publishes a `RECONCILIATION_COMPLETED` Kafka event.
7. The reconciliation consumer reads this event and fires a Slack alert if `mismatchCount > 0`.

### Admin domain (`src/domains/admin/`)

Internal debugging and operations endpoints. Not exposed to merchants — sits behind VPN/private network in production.

**`GET /admin/payments/:id/state`** — returns a full audit snapshot in a single response:
- Current payment record
- All `payment_events` rows in chronological order (who changed what and when)
- All `ledger_entries` rows (the double-entry lines)
- All `outbox` rows for this payment (pending, sent, or failed)
- All `dead_letter_messages` rows referencing this payment

**`GET /admin/dlq`** — lists dead-letter messages, filterable by `status` (`OPEN`, `RESOLVED`, `IGNORED`) and topic name.

**`POST /admin/dlq/:id/replay`** — re-publishes the stored payload to the original topic (derived by stripping the `.dlq` suffix), then marks the message `RESOLVED`. Safe to call multiple times — returns 409 if already resolved.

**`POST /admin/dlq/:id/discard`** — marks a message `IGNORED` with a required operator note. Used for known-bad payloads that should not be reprocessed.

---

## 7. Infrastructure Components

### PostgreSQL (`src/infrastructure/database/`)

**`pg-pool.ts`**: manages a singleton `pg.Pool`. Connection parameters (host, port, database, user, password, pool size) come from the validated config.

**`transaction.ts`**: provides `withTransaction<T>(pool, fn)` — a generic helper that acquires a client, begins a transaction, runs `fn(client)`, and commits. On any error, it rolls back and rethrows. All domain writes that require atomicity use this helper.

**`migrator.ts`**: reads all `.sql` files from the `migrations/` directory in filename order, acquires a Postgres advisory lock (prevents two application instances from running migrations simultaneously on startup), and executes each migration that hasn't run yet. Migration files are never modified after they are committed — new changes are always new numbered files.

### Redis (`src/infrastructure/redis/`)

**`redis-client.ts`**: singleton `ioredis` client.

**`lua-scripts.ts`**: exports `setIfNotExists(key, value, ttlSeconds)` — the atomic Lua script used by the idempotency middleware. Using a Lua script rather than a Redis transaction avoids the TOCTOU race between `WATCH`/`GET`/`SET`.

### Kafka (`src/infrastructure/kafka/`)

**`kafka-client.ts`**: singleton `KafkaJS` instance configured with the broker list from environment variables.

**`producer.ts`**: creates a single idempotent producer (`idempotent: true`) shared by all publishers. The idempotent flag tells Kafka to deduplicate messages from this producer in the event of a retry after an uncertain acknowledgement — providing exactly-once semantics at the producer level. Every `sendMessage()` call adds `traceId` and `correlationId` from `AsyncLocalStorage` as message headers, and records Prometheus duration metrics.

**`consumer-manager.ts`**: the central retry/DLQ orchestrator. Every consumer registration goes through `registerConsumer()`, which wraps the handler in the three-path routing logic described in §5.4. The `initConsumerManager(pool)` function must be called at startup before any `registerConsumer()` calls — it provides the `OutboxRepository` needed for durable retry scheduling.

**`topics.ts`**: defines all topic names as a typed constant object. Importing a string literal anywhere else is disallowed — all references must go through this file.

### Stripe (`src/infrastructure/stripe/`)

**`stripe-checkout.ts`**: wraps `stripe.checkout.sessions.create()` in `retryWithBackoff`:
- 3 attempts maximum
- Initial delay 500ms, max delay 4s, jitter factor 0.3
- `isRetryable` predicate: retries network errors, HTTP 429, and HTTP 5xx. **Never** retries 4xx — a bad request won't succeed on retry.
- Also wraps `stripe.checkout.sessions.retrieve()` used by `StuckPaymentsChecker`.

**`stripe-webhook-parser.ts`**: wraps `stripe.webhooks.constructEvent()` with typed narrowing helpers (`isCheckoutSessionCompleted()`, `isChargeRefunded()`, etc.) so handlers receive fully-typed Stripe objects.

**`stripe-reconciliation.ts`**: implements `listChargesForDateRange(from, to)` as an async generator. Pages through Stripe's cursor-based `/v1/charges` endpoint, yielding one charge at a time. Memory usage is bounded to one page (100 charges) regardless of total volume.

### Outbox (`src/infrastructure/outbox/`)

**`outbox-repository.ts`**:
- `insert(client, params)` — inserts a new outbox row inside an existing transaction. Called by service methods.
- `insertRetry(params)` — inserts a retry row at the pool level (outside any transaction). Called by `consumer-manager` when scheduling a durable retry. Accepts a `scheduledAt` field.
- `fetchPending(batchSize)` — selects pending rows with `scheduled_at <= NOW()` using `FOR UPDATE SKIP LOCKED`.
- `markProcessed(id)`, `markFailed(id, error)`, `incrementRetry(id, error)` — relay lifecycle methods.

**`outbox-relay.ts`**: a `setInterval` loop (configurable poll interval, default 500ms) that calls `sweep()` on each tick. The `sweep()` method is guarded by an `isRunning` flag to prevent overlapping sweeps if a sweep takes longer than the poll interval. Each publish is wrapped in `retryWithBackoff` (2 inner attempts). On permanent failure (max sweeps exceeded), the row is marked `FAILED` for operator investigation.

### Scheduler (`src/infrastructure/scheduler/`)

**`cron.ts`**: sets up two `node-cron` jobs:
- **Reconciliation** — runs at `0 2 * * *` (2 AM daily). Calls `ReconciliationService.runReconciliation(yesterday)`.
- **Stuck payments checker** — runs at `*/5 * * * *` (every 5 minutes). Calls `StuckPaymentsChecker.run()`.

### Alerting (`src/infrastructure/alerting/`)

**`slack-alerter.ts`**: `sendAlert(payload)` posts a structured Slack Block Kit message to the configured webhook URL. It is designed to **never throw** — alert delivery failures must not break payment processing. If `ALERT_SLACK_WEBHOOK_URL` is not configured, it degrades gracefully to a `logger.warn()` call. Non-200 responses from Slack are logged but not thrown.

---

## 8. Database Schema

All monetary amounts are stored as `BIGINT` in minor units (cents, paise). Floating-point numbers are never used for money. The `Money` value object in `src/common/utils/money.ts` wraps all arithmetic operations.

### Tables

**`merchants`** — one row per merchant. API keys are hashed with HMAC-SHA256 before storage; the plaintext is returned exactly once at key generation and never persisted.

**`payments`** — the central table. Status transitions:
`PENDING → PROCESSING → COMPLETED | FAILED | EXPIRED | REFUNDED | CANCELLED`.
Has a `UNIQUE INDEX ON (merchant_id, idempotency_key)` for database-level duplicate prevention.

**`payment_events`** — immutable append-only audit log. Every status transition creates a row recording `old_status`, `new_status`, `actor` (e.g. `stripe_webhook`, `stuck_payments_checker`), and a `payload` with context.

**`ledger_accounts`** — seeded at migration time with the four accounts: `RECEIVABLE`, `REVENUE`, `REFUND_EXPENSE`, `STRIPE_FEE`.

**`ledger_entries`** — double-entry ledger rows. Two entries per `transaction_id`, enforced by a database trigger to sum to zero (debits = credits). Never updated or deleted.

**`webhook_events`** — Stripe webhook deduplication. Unique on `stripe_event_id`. `processed = false` means the event was received but processing failed or is in-flight; `processed = true` means fully handled.

**`outbox`** — the Transactional Outbox table. `status` cycles through `PENDING → SENT` (or `FAILED` on exhaustion). `scheduled_at` supports delayed retries — the relay skips rows where `scheduled_at > NOW()`.

**`dead_letter_messages`** — messages that exhausted all retry attempts. `status` is `OPEN`, `RESOLVED`, or `IGNORED`. `notes` records the resolution reason when an operator acts on the message.

**`reconciliation_reports`** — one row per reconciliation run. `mismatches` is a `JSONB` array of mismatch objects. Unique on `run_date`.

### Key indexes

```sql
-- Idempotency (also the primary uniqueness constraint)
UNIQUE INDEX ON payments(merchant_id, idempotency_key)

-- Webhook deduplication
UNIQUE INDEX ON webhook_events(stripe_event_id)

-- OutboxRelay polling (partial index — only covers PENDING rows)
INDEX ON outbox(scheduled_at, created_at) WHERE status = 'PENDING'

-- Payment list queries with keyset cursor pagination
INDEX ON payments(merchant_id, created_at DESC, id DESC)

-- Stuck payment detection
INDEX ON payments(status, updated_at) WHERE status = 'PROCESSING'

-- DLQ management queries
INDEX ON dead_letter_messages(status)
INDEX ON dead_letter_messages(payment_id)
```

### Migrations

Migration files live in `migrations/` and are numbered sequentially (`001_...sql`, `002_...sql`). The migrator acquires a Postgres advisory lock at startup, reads files in order, and skips files already recorded in an internal `schema_migrations` table. **Existing migration files are never modified** — changes are always new numbered files.

---

## 9. API Reference

All routes under `/v1/` require `Authorization: Bearer <api_key>`. The webhook route authenticates via Stripe signature.

### Payments

```
POST /v1/payments
```
Creates a payment and returns a Stripe Checkout URL. Requires `Idempotency-Key` header.

Request body:
```json
{
  "orderId": "string",
  "customerId": "string",
  "amount": 50000,
  "currency": "INR",
  "paymentMethod": "CREDIT_CARD | DEBIT_CARD | UPI | NET_BANKING",
  "successUrl": "https://...",
  "cancelUrl": "https://...",
  "metadata": { "key": "value" }
}
```

- `amount`: integer, minor units (paise for INR, cents for USD)
- `successUrl` / `cancelUrl`: must be HTTPS — HTTP URLs are rejected

Response `201`:
```json
{
  "data": { "paymentId": "uuid", "checkoutUrl": "https://checkout.stripe.com/..." }
}
```

---

```
GET /v1/payments/:id
```
Returns a single payment. Returns `404` if the ID belongs to a different merchant (avoids information leakage).

---

```
GET /v1/payments?limit=20&cursor=...&status=COMPLETED&fromDate=...&toDate=...
```
Lists payments with keyset cursor pagination. `cursor` is a base64url-encoded `{ createdAt, id }` pair. `nextCursor` in the response is `null` on the last page.

---

### Webhooks

```
POST /webhooks/stripe
```
Stripe webhook endpoint. Uses `express.raw()` middleware — the raw Buffer is required for signature verification. Always returns `200` immediately.

---

### Reconciliation

```
GET /v1/reconciliation
GET /v1/reconciliation/:date
POST /v1/reconciliation/trigger  { "date": "YYYY-MM-DD" }
```

---

### Ledger

```
GET /v1/ledger/accounts/:code/balance?currency=INR
GET /v1/ledger/payments/:paymentId/entries
```

---

### Admin (internal only — must be behind VPN)

```
GET  /admin/payments/:id/state
GET  /admin/dlq?status=OPEN&topic=payment.completed&limit=50&offset=0
POST /admin/dlq/:id/replay
POST /admin/dlq/:id/discard  { "note": "reason" }
```

---

### Health and Metrics

```
GET /health      — checks PostgreSQL and Redis connectivity
GET /metrics     — Prometheus text format
```

---

## 10. Observability

### Logging

All log output is structured JSON via Pino. Every log line automatically carries `traceId` and `correlationId`, which are set at the start of each HTTP request and propagated through all downstream calls via Node.js `AsyncLocalStorage`. You never need to pass these IDs explicitly — they appear on every log line that runs in the context of that request.

```json
{
  "level": "info",
  "time": 1712345678000,
  "traceId": "abc-123",
  "correlationId": "req-xyz",
  "paymentId": "pay-uuid",
  "msg": "Payment created successfully"
}
```

Log levels used consistently:
- `fatal` — process is about to exit (`uncaughtException`, `unhandledRejection`)
- `error` — something failed that requires attention (DLQ messages, Stripe errors, failed outbox rows)
- `warn` — abnormal but handled (retryable failures, stuck payments detected, reconciliation mismatches)
- `info` — normal lifecycle events (payment created, webhook processed, outbox published)
- `debug` — verbose tracing (individual outbox batches, unhandled Kafka event types)

### Prometheus Metrics

Scraped at `GET /metrics`. All metrics carry the default label `app=payment-system`.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `http_request_duration_seconds` | Histogram | method, route, status | Request latency |
| `http_errors_total` | Counter | status, code | HTTP errors |
| `payment_created_total` | Counter | method, currency | Payments initiated |
| `payment_completed_total` | Counter | method, currency | Payments completed |
| `payment_failed_total` | Counter | method, currency, reason | Payment failures |
| `payment_amount_minor_units` | Histogram | method, currency | Payment amount distribution |
| `stripe_api_call_duration_seconds` | Histogram | operation, result | Stripe API latency |
| `kafka_producer_send_duration_seconds` | Histogram | topic, result | Kafka publish latency |
| `kafka_consumer_group_lag` | Gauge | group, topic, partition | Consumer lag |
| `outbox_processed_total` | Counter | topic | Successfully published outbox rows |
| `outbox_failed_total` | Counter | topic | Permanently failed outbox rows |
| `idempotency_cache_hits_total` | Counter | — | Redis idempotency hits |
| `idempotency_cache_misses_total` | Counter | — | New (non-duplicate) requests |
| `reconciliation_mismatch_total` | Counter | type | Mismatches found per type |
| `reconciliation_duration_seconds` | Histogram | — | Reconciliation run time |
| `reconciliation_last_run_timestamp_seconds` | Gauge | — | Unix timestamp of last run |
| `kafka_dlq_messages_total` | Counter | topic | Messages sent to DLQ |
| `payment_retry_queue_processed_total` | Counter | eventType | Messages processed from retry queue |
| `payment_stuck_detected_total` | Counter | method | Payments found stuck in PROCESSING |
| `payment_stuck_recovered_total` | Counter | method, outcome | Stuck payments resolved |

### Alerting

**Slack** alerts are sent for:
- Any message routed to a DLQ topic (`severity: critical`, includes topic, offset, payment ID, error)
- Reconciliation mismatches (`severity: critical`, includes date, count, and first 5 mismatch details)
- Alert delivery failures degrade gracefully to `logger.warn` — they never break processing

**Grafana** (recommended alert rules):
- `kafka_dlq_messages_total` rate > 0 for 5 minutes
- `reconciliation_last_run_timestamp_seconds` older than 26 hours (missed run)
- `reconciliation_mismatch_total` rate > 0
- `outbox_failed_total` rate > 0
- `http_request_duration_seconds{route="/v1/payments",quantile="0.99"}` > 2s

---

## 11. Security

### API Authentication

Merchants authenticate with a `Bearer` token. The raw API key is never stored — only its HMAC-SHA256 hash (keyed with `HMAC_SECRET` from the environment). Comparison uses `crypto.timingSafeEqual` to prevent timing attacks.

Lookups follow a two-level cache:
1. Redis — cached for 10 minutes after first DB hit
2. PostgreSQL — authoritative source

### Stripe Webhook Signature

The `/webhooks/stripe` endpoint uses `express.raw()` to access the raw request body. `stripe.webhooks.constructEvent()` verifies the HMAC-SHA256 signature using the raw bytes and the `STRIPE_WEBHOOK_SECRET`. Requests without a valid signature are rejected with `400`. Stripe also embeds a timestamp in the signature and the library rejects events older than 5 minutes, preventing replay attacks.

### URL Validation

`successUrl` and `cancelUrl` in payment creation are validated to be well-formed URLs (via Zod) **and** must use the `https://` scheme. HTTP URLs are rejected to prevent open-redirect attacks where an attacker provides an HTTP URL and downgrades the redirect.

### Rate Limiting

A global rate limiter (`express-rate-limit`) allows 200 requests per IP per minute with standard RateLimit headers. This protects against basic abuse and scanning. For production, per-merchant rate limiting should be added based on the authenticated `merchantId`.

### Helmet

`helmet()` is applied to all routes, setting security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `Content-Security-Policy`, and others.

---

## 12. Running the System

### Prerequisites

- Node.js 20
- Docker and Docker Compose
- Stripe account with a test API key and webhook secret
- Slack incoming webhook URL (optional — alerting degrades to logs without it)

### Start infrastructure

```bash
# Minimum required services
docker-compose up -d postgres redis kafka

# Full stack including observability
docker-compose up -d
```

Services started:

| Service | Port | Purpose |
|---|---|---|
| postgres | 5432 | Primary database |
| redis | 6379 | Idempotency + API key cache |
| kafka | 9092 | Message bus |
| prometheus | 9090 | Metrics scraping |
| grafana | 3001 | Dashboards (admin/admin) |
| kafka-ui | 8080 | Kafka topic browser |

### Configure environment

```bash
cp .env.example .env
# Edit .env with your Stripe keys, database URL, etc.
```

Required environment variables:

```
NODE_ENV=development
PORT=3000

DATABASE_URL=postgresql://payment:payment@localhost:5432/payment_db

REDIS_URL=redis://localhost:6379

KAFKA_BROKERS=localhost:9092
KAFKA_GROUP_ID_PREFIX=payment-system

STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

HMAC_SECRET=<random-256-bit-key>

# Optional — alerting degrades to logs if not set
ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/...
```

### Start the application

```bash
npm install

# Development (hot-reload)
npm run dev

# Production
npm run build
npm start
```

### Generate a merchant API key

```bash
npm run generate-api-key "Acme Corp" "billing@acme.com"
# Prints: api_key=psk_live_... (save this — it is never stored in plaintext)
```

### Forward Stripe webhooks locally

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
# Copy the webhook signing secret it prints into STRIPE_WEBHOOK_SECRET in .env
```

### Run migrations manually

```bash
npm run migrate
```

### Trigger reconciliation manually

```bash
npm run reconcile 2024-01-15
# Or for yesterday
npm run reconcile
```

---

## 13. Operational Playbook

### Investigating a payment

Use the admin state dump endpoint to get a full picture in one call:

```
GET /admin/payments/:paymentId/state
```

The response shows:
- Current payment status and all Stripe identifiers
- Every status transition with actor and timestamp (`payment_events`)
- All ledger entries (double-entry lines for financial audit)
- Outbox rows (were Kafka events published or stuck?)
- Any DLQ messages referencing this payment

### Investigating DLQ messages

```bash
# List all open DLQ messages
GET /admin/dlq?status=OPEN

# Filter by topic
GET /admin/dlq?status=OPEN&topic=payment.completed

# Replay — re-publishes to original topic
POST /admin/dlq/:id/replay

# Discard — mark as not worth replaying
POST /admin/dlq/:id/discard
{ "note": "Test event from staging — safe to ignore" }
```

### Investigating a stuck outbox

If `outbox_failed_total` increments, query the database directly:

```sql
SELECT id, topic, event_type, retry_count, error, created_at
FROM outbox
WHERE status = 'FAILED'
ORDER BY created_at DESC;
```

A `FAILED` outbox row means the OutboxRelay exhausted `OUTBOX_MAX_RETRIES` attempts to publish to Kafka. Investigate whether:
- Kafka is reachable from the application
- The topic exists
- The payload is valid

To manually re-queue a failed outbox row, reset its status:

```sql
UPDATE outbox SET status = 'PENDING', retry_count = 0, error = NULL
WHERE id = '<row-id>';
```

### Investigating a reconciliation mismatch

```bash
# Get the full mismatch report for a date
GET /v1/reconciliation/2024-01-15
```

Mismatch types and what to do:

| Type | Meaning | Action |
|---|---|---|
| `MISSING_IN_DB` | Stripe charge has no internal payment record | Investigate if the payment was created outside this system or via the Stripe dashboard |
| `MISSING_IN_STRIPE` | Internal payment marked COMPLETED but no Stripe charge | Could be a test payment, a bug in status transitions, or a Stripe refund already processed |
| `AMOUNT_MISMATCH` | Same `payment_intent_id`, different amounts | Check for currency conversion issues or partial captures |

### Restarting the application safely

The application handles graceful shutdown: `SIGTERM` stops the HTTP server, drains in-flight requests (30s max), disconnects Kafka consumers, disconnects the Kafka producer, stops the OutboxRelay, closes Redis, and closes the PostgreSQL pool. Sending `SIGTERM` is safe at any time — no data will be lost.

In-flight Kafka messages that were being processed will have their offsets uncommitted. On restart, the consumer group will re-deliver them from the last committed offset. The three-path routing logic (§5.4) handles this safely.

### Kafka consumer lag

If `kafka_consumer_group_lag` is growing, the consumers are falling behind the producers. Common causes:
- Downstream service is slow (retry delays are accumulating in the retry queue)
- Application CPU or memory under pressure
- Kafka broker issues

The retry queue topics (`payment.retry`) will grow under sustained failures — this is expected and intentional. Monitor `payment_retry_queue_processed_total` to verify retries are eventually succeeding.
