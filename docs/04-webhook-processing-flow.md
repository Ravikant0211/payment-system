# Webhook Payment Completion Flow

How Stripe webhook events are received, verified, deduplicated, and processed — all within a single atomic database transaction.

```mermaid
sequenceDiagram
    actor ST as Stripe
    participant WC as WebhookController
    participant WS as WebhookService
    participant DB as PostgreSQL
    participant LS as LedgerService
    participant OR as OutboxRelay
    participant KF as Kafka

    ST->>WC: POST /webhooks/stripe<br/>Stripe-Signature: t=timestamp,v1=hmac<br/>Content-Type: application/json (raw Buffer)

    WC->>WC: stripe.webhooks.constructEvent()<br/>HMAC-SHA256 over raw body + secret<br/>Rejects if signature invalid or timestamp > 5 min old

    Note over WC: Returns 200 IMMEDIATELY.<br/>Stripe retries with exponential backoff<br/>if it does not receive 2xx within 30s.

    WC-->>ST: 200 OK
    WC->>WS: processStripeEvent(event) [async, detached]

    WS->>DB: BEGIN TRANSACTION

    WS->>DB: SELECT * FROM webhook_events<br/>WHERE stripe_event_id = evt_xxx

    alt Already processed — duplicate delivery from Stripe
        DB-->>WS: row with processed = true
        WS->>DB: ROLLBACK
        Note over WS: Silent skip — idempotent
    else New event
        DB-->>WS: null (not seen before)
        WS->>DB: INSERT webhook_events<br/>stripe_event_id=evt_xxx, processed=false

        alt checkout.session.completed
            WS->>DB: UPDATE payments<br/>SET status=COMPLETED,<br/>stripe_payment_intent_id=pi_xxx
            WS->>LS: recordPaymentReceived(payment, client)
            LS->>DB: INSERT ledger_entry<br/>transaction_id=uuid<br/>account=ACCOUNTS_RECEIVABLE, type=DEBIT, amount
            LS->>DB: INSERT ledger_entry<br/>transaction_id=uuid<br/>account=REVENUE, type=CREDIT, amount
            Note over DB: DB TRIGGER fires on ledger_entries:<br/>SELECT SUM(debits) = SUM(credits)<br/>WHERE transaction_id = uuid<br/>Raises EXCEPTION if unbalanced.<br/>Guarantees double-entry at the DB level.
            WS->>DB: INSERT outbox (PAYMENT_COMPLETED)

        else checkout.session.expired
            WS->>DB: UPDATE payments SET status=EXPIRED
            WS->>DB: INSERT outbox (PAYMENT_EXPIRED)

        else payment_intent.payment_failed
            WS->>DB: UPDATE payments<br/>SET status=FAILED,<br/>failure_reason=decline_code
            WS->>DB: INSERT outbox (PAYMENT_FAILED)

        else charge.refunded
            WS->>DB: UPDATE payments SET status=REFUNDED
            WS->>LS: recordRefund(payment, refundAmount, client)
            LS->>DB: INSERT ledger_entry<br/>DEBIT REVENUE (reverse)
            LS->>DB: INSERT ledger_entry<br/>CREDIT ACCOUNTS_RECEIVABLE (reverse)
            WS->>DB: INSERT outbox (REFUND_COMPLETED)

        else Unknown event type
            Note over WS: logger.debug only<br/>Returns 200 to Stripe — no processing needed
        end

        WS->>DB: UPDATE webhook_events<br/>SET processed=true, processed_at=NOW()
        WS->>DB: COMMIT

        loop OutboxRelay picks up
            OR->>DB: SELECT pending outbox rows
            OR->>KF: publish PAYMENT_COMPLETED / PAYMENT_FAILED / ...
            OR->>DB: mark SENT
        end
    end
```

## Critical Properties

### Why Return 200 Immediately?
Stripe will retry a webhook if it doesn't receive a `2xx` within **30 seconds**. The actual processing (DB writes, ledger entries) can take longer, and failures should not cause Stripe to retry — because each retry would be a new duplicate delivery, handled by the deduplication layer.

### Idempotency by `stripe_event_id`
Stripe can deliver the same event multiple times (at-least-once guarantee). The `webhook_events` table stores every `stripe_event_id` seen. On duplicate delivery:
- If `processed = true` → silently skip (the first delivery already completed successfully).
- If `processed = false` → first delivery is still in-flight or failed mid-transaction; the new delivery can proceed.

### Everything in One Transaction
All five writes happen atomically:
1. `webhook_events` dedup record
2. `payments` status update
3. `ledger_entries` rows (×2 for double-entry)
4. `outbox` row for downstream Kafka event
5. `webhook_events.processed = true`

A crash at any point rolls back all writes. The next retry starts clean.

### Double-Entry Ledger Enforcement
The DB trigger on `ledger_entries` runs `AFTER INSERT` and checks:
```sql
SELECT SUM(amount) FILTER (WHERE entry_type = 'DEBIT')
     = SUM(amount) FILTER (WHERE entry_type = 'CREDIT')
WHERE transaction_id = NEW.transaction_id
```
An imbalance raises a Postgres exception, rolling back the entire transaction. The ledger **cannot** become inconsistent — not even through a code bug.
