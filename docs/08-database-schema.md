# Database Schema

All nine tables, their columns, and relationships. All monetary amounts are stored as `BIGINT` minor units (cents, paise) — never floats.

```mermaid
erDiagram
    merchants {
        uuid id PK
        string name
        string email
        string api_key_hash
        boolean is_active
        timestamptz created_at
    }

    payments {
        uuid id PK
        uuid merchant_id FK
        string order_id
        string customer_id
        string idempotency_key
        bigint amount
        string currency
        string payment_method
        string status
        string stripe_session_id
        string stripe_payment_intent_id
        string checkout_url
        string failure_reason
        int retry_count
        string success_url
        string cancel_url
        jsonb metadata
        timestamptz created_at
        timestamptz updated_at
    }

    payment_events {
        uuid id PK
        uuid payment_id FK
        string event_type
        string old_status
        string new_status
        string actor
        jsonb payload
        timestamptz created_at
    }

    ledger_accounts {
        uuid id PK
        string code
        string name
        string type
        string normal_balance
    }

    ledger_entries {
        uuid id PK
        uuid transaction_id
        uuid account_id FK
        uuid payment_id FK
        string entry_type
        bigint amount
        string currency
        timestamptz created_at
    }

    webhook_events {
        uuid id PK
        string stripe_event_id
        string event_type
        jsonb payload
        boolean processed
        string error
        timestamptz created_at
    }

    outbox {
        uuid id PK
        string aggregate_type
        string aggregate_id
        string topic
        string event_type
        jsonb payload
        jsonb headers
        string status
        int retry_count
        timestamptz scheduled_at
        timestamptz sent_at
        timestamptz created_at
    }

    dead_letter_messages {
        uuid id PK
        string topic
        int partition
        bigint kafka_offset
        uuid payment_id FK
        string event_type
        jsonb payload
        string error
        string status
        string notes
        timestamptz resolved_at
        timestamptz created_at
    }

    reconciliation_reports {
        uuid id PK
        date run_date
        string status
        int total_internal
        int total_external
        int matched_count
        int mismatch_count
        jsonb mismatches
        string error
        timestamptz started_at
        timestamptz completed_at
    }

    merchants            ||--o{ payments              : "owns"
    payments             ||--o{ payment_events         : "audit trail"
    payments             ||--o{ ledger_entries          : "double-entry lines"
    ledger_accounts      ||--o{ ledger_entries          : "receives entries"
    payments             ||--o{ dead_letter_messages    : "may have DLQ msgs"
```

## Table Reference

### `merchants`
One row per merchant. API keys are stored as HMAC-SHA256 hashes — the plaintext is never persisted after generation.

### `payments`
Central table. Lifecycle: `PENDING → PROCESSING → COMPLETED | FAILED | EXPIRED | REFUNDED`.

| Column | Notes |
|---|---|
| `amount` | BIGINT minor units (e.g. 1000 = $10.00 USD / ₹10.00 INR) |
| `payment_method` | `CREDIT_CARD`, `DEBIT_CARD`, `UPI`, `NET_BANKING` |
| `status` | `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `EXPIRED`, `REFUNDED`, `CANCELLED` |
| `idempotency_key` | UNIQUE per `(merchant_id, idempotency_key)` — DB-level duplicate prevention |
| `stripe_session_id` | Stripe Checkout Session ID (`cs_xxx`) |
| `stripe_payment_intent_id` | Set when payment completes (`pi_xxx`) — used for reconciliation |

### `payment_events`
Immutable append-only audit log. Every status transition writes a row with the `actor` field (e.g. `stripe_webhook`, `stuck_payments_checker`, `reconciliation`). Never updated or deleted.

### `ledger_accounts` (seeded)
| Code | Type | Normal Balance |
|---|---|---|
| `ACCOUNTS_RECEIVABLE` | ASSET | DEBIT |
| `REVENUE` | REVENUE | CREDIT |
| `REFUNDS_PAYABLE` | LIABILITY | CREDIT |
| `STRIPE_FEES` | EXPENSE | DEBIT |

### `ledger_entries`
Double-entry bookkeeping. Every payment completion creates two rows sharing the same `transaction_id`:
- DEBIT `ACCOUNTS_RECEIVABLE` +amount
- CREDIT `REVENUE` +amount

A **PostgreSQL trigger** (`AFTER INSERT`) validates that `SUM(debits) = SUM(credits)` for each `transaction_id`. An imbalanced insert raises an exception and rolls back the transaction — the ledger cannot become inconsistent.

### `webhook_events`
Deduplication table for Stripe webhook events. Indexed on `stripe_event_id` (UNIQUE). `processed = false` means the event was received but processing failed mid-transaction — next delivery can retry. `processed = true` means the event was fully handled.

### `outbox`
Implements the Transactional Outbox Pattern. Written in the same DB transaction as the business data. The `OutboxRelay` polls `WHERE status = 'PENDING' AND scheduled_at <= NOW()` using `FOR UPDATE SKIP LOCKED`.

| `status` | Meaning |
|---|---|
| `PENDING` | Waiting to be published |
| `SENT` | Successfully published to Kafka |
| `FAILED` | Exhausted max retries; requires investigation |

`scheduled_at` is used for durable Kafka consumer retries — set to a future timestamp when a consumer handler fails with `RetryableError`.

### `dead_letter_messages`
Messages that could not be processed after all retry attempts. Operators manage these via `/admin/dlq`.

| `status` | Meaning |
|---|---|
| `OPEN` | Requires operator action |
| `RESOLVED` | Replayed successfully |
| `IGNORED` | Discarded by operator (with required note) |

### `reconciliation_reports`
One row per reconciliation run. `mismatches` is a `JSONB` array of mismatch objects with `type`, `paymentId`, `stripeChargeId`, `description`. `run_date` has a UNIQUE constraint — one report per day.

## Key Indexes

```sql
-- Idempotency enforcement (business rule + performance)
UNIQUE INDEX ON payments(merchant_id, idempotency_key)

-- Fast webhook deduplication
UNIQUE INDEX ON webhook_events(stripe_event_id)

-- OutboxRelay polling (partial index — only PENDING rows)
INDEX ON outbox(scheduled_at, created_at) WHERE status = 'PENDING'

-- Payment list queries (keyset pagination)
INDEX ON payments(merchant_id, created_at DESC, id DESC)

-- Stuck payments detection
INDEX ON payments(status, updated_at) WHERE status = 'PROCESSING'

-- DLQ management
INDEX ON dead_letter_messages(status)
INDEX ON dead_letter_messages(payment_id)
```
