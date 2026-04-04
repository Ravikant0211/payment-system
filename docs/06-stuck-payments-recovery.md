# Stuck Payments Recovery (Payment Delay Handling)

Handles the case where a Stripe webhook is missed or delayed — common with async payment methods like UPI and net banking.

```mermaid
flowchart TD
    TICK(["Cron fires every 5 minutes"]) --> FETCH["findStuckPayments()
    SELECT * FROM payments
    WHERE status = 'PROCESSING'
    AND updated_at < NOW() - 35min
    LIMIT 100"]

    FETCH --> EMPTY{Any candidates?}
    EMPTY -->|"No"| DONE["Exit — nothing to do"]

    EMPTY -->|"Yes"| LOOP["For each candidate payment"]

    LOOP --> MCHECK{"Past this payment
    method's threshold?"}

    MCHECK -->|"CREDIT_CARD / DEBIT_CARD
    threshold = 35 min
    NOT reached yet"| SKIP["Skip
    Will re-evaluate next run"]
    MCHECK -->|"UPI / NET_BANKING
    threshold = 3 hours
    NOT reached yet"| SKIP

    MCHECK -->|"Past threshold — evaluate"| SESSION{"Has
    stripe_session_id?"}

    SESSION -->|"No
    Stripe call failed at creation"| FAIL_NS["transitionToFailed()
    reason: 'No Stripe session created'"]

    SESSION -->|"Yes"| POLL["retrieveCheckoutSession()
    from Stripe API"]

    POLL --> ERR{"Stripe API
    error?"}
    ERR -->|"Yes
    Stripe may be temporarily down"| CAUTIOUS["Leave unchanged
    Do NOT mark failed
    Re-evaluate next run"]

    ERR -->|"No"| STATUS{"session.status?"}

    STATUS -->|"complete"| COMPLETE["transitionToCompleted()
    ─────────────────────────────────
    BEGIN TRANSACTION
    UPDATE payments SET status=COMPLETED
    INSERT payment_events (actor=stuck_checker)
    INSERT outbox PAYMENT_COMPLETED
    COMMIT"]

    STATUS -->|"expired"| FAILED["transitionToFailed()
    ─────────────────────────────────
    BEGIN TRANSACTION
    UPDATE payments SET status=FAILED
    INSERT payment_events (actor=stuck_checker)
    INSERT outbox PAYMENT_FAILED
    COMMIT"]

    STATUS -->|"open AND
    session.expires_at passed"| FAILED

    STATUS -->|"open AND
    session still valid"| RECHECK["Leave unchanged
    UPI/net banking may still complete
    Re-evaluate next run"]

    COMPLETE --> KAFKA_C["OutboxRelay publishes
    PAYMENT_COMPLETED to Kafka
    Downstream: ledger recording,
    analytics, merchant notification"]

    FAILED --> KAFKA_F["OutboxRelay publishes
    PAYMENT_FAILED to Kafka
    Downstream: merchant notification"]

    style COMPLETE fill:#6bcb77
    style KAFKA_C fill:#6bcb77
    style FAILED fill:#ff6b6b,color:#fff
    style KAFKA_F fill:#ff6b6b,color:#fff
    style CAUTIOUS fill:#ffd93d
```

## Why This Is Needed

Stripe sends webhooks for payment completion/failure, but they can be:
- **Missed**: network issues between Stripe and the application.
- **Delayed**: Stripe queues webhooks and retries with exponential backoff — delays of minutes or hours are possible.
- **Lost on restart**: if the application was down when Stripe attempted delivery.

For **UPI and net banking**, the payment itself is asynchronous — the customer may not complete the bank redirect immediately, and bank processing can legitimately take 1–3 hours. Webhooks for these methods arrive later than card payments.

The `StuckPaymentsChecker` acts as a **safety net**: it periodically polls Stripe directly for any payment that has been in `PROCESSING` too long, recovering missed webhook events.

## Per-Method Thresholds

| Payment Method | Threshold | Rationale |
|---|---|---|
| CREDIT_CARD | 35 min | Stripe checkout session expires after 30 min; +5 min buffer for webhook arrival |
| DEBIT_CARD | 35 min | Same as credit card |
| UPI | 3 hours | Bank processing is genuinely async; false positive risk high if threshold is low |
| NET_BANKING | 3 hours | Same as UPI |

## Event Source in Audit Trail

When the checker recovers a payment, the event is recorded with `actor = "stuck_payments_checker"` in `payment_events`, so operators can distinguish:
- `actor = "stripe_webhook"` — normal completion via webhook
- `actor = "stuck_payments_checker"` — recovered by polling Stripe

The outbox payload also carries `recoveredByChecker: true` for downstream consumers to handle appropriately (e.g. skip duplicate analytics recording).

## Prometheus Metrics

| Metric | Labels | Meaning |
|---|---|---|
| `stuck_payments_detected_total` | `method` | How often payments are found stuck |
| `stuck_payments_recovered_total` | `method, outcome` | How often they are successfully recovered; `outcome` = `completed` or `failed` |
