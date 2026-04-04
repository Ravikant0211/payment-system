# Nightly Reconciliation Flow

Compares the internal PostgreSQL records against Stripe's charge history to detect discrepancies — missing records, phantom charges, and amount mismatches.

```mermaid
sequenceDiagram
    participant CR as Cron (2 AM nightly)
    participant RS as ReconciliationService
    participant DB as PostgreSQL
    participant ST as Stripe API
    participant KF as Kafka
    participant RC as Reconciliation Consumer
    participant SL as Slack

    CR->>RS: runReconciliation(yesterday)
    RS->>DB: INSERT reconciliation_reports<br/>(run_date, status=RUNNING)

    RS->>DB: SELECT * FROM payments<br/>WHERE status = 'COMPLETED'<br/>AND created_at BETWEEN 00:00 AND 23:59<br/>AND stripe_payment_intent_id IS NOT NULL
    DB-->>RS: internalPayments[]

    Note over RS: Build internalMap<br/>Map&lt;paymentIntentId, { paymentId, amount, currency }&gt;

    loop Page through ALL Stripe charges (async generator)
        RS->>ST: GET /v1/charges?created[gte]=X&created[lte]=Y<br/>&starting_after=cursor&limit=100
        ST-->>RS: { data: charges[], has_more, next_cursor }
    end

    Note over RS: Build externalMap<br/>Map&lt;paymentIntentId, { chargeId, amount, currency }&gt;

    RS->>RS: Compare both maps
    Note over RS: MISSING_IN_DB: in Stripe, not in DB<br/>MISSING_IN_STRIPE: in DB, not in Stripe<br/>AMOUNT_MISMATCH: same PI, different amounts

    RS->>DB: UPDATE reconciliation_reports SET<br/>status=COMPLETED,<br/>total_internal=N, total_external=M,<br/>matched_count=K, mismatch_count=J,<br/>mismatches=[...] (JSONB),<br/>completed_at=NOW()

    RS->>KF: PUBLISH reconciliation.done<br/>{ eventType, date, mismatchCount, mismatches[] }

    KF->>RC: Consume reconciliation.done

    alt mismatchCount > 0
        RC->>SL: sendAlert(severity=critical)<br/>title: "Reconciliation mismatches — YYYY-MM-DD"<br/>body: first 5 mismatches listed<br/>fields: { Date, Mismatch count, Review endpoint }
        Note over SL: Ops team reviews at<br/>GET /v1/reconciliation/:date
    else All records matched
        RC->>RC: logger.info — no alert sent
    end
```

## Mismatch Categories

| Type | Meaning | Likely Cause |
|---|---|---|
| `MISSING_IN_DB` | Stripe has a charge, our DB does not | Webhook was never received; payment created outside this system |
| `MISSING_IN_STRIPE` | DB has a COMPLETED payment, Stripe has no charge | Data integrity issue; refund already processed; Stripe test vs live mismatch |
| `AMOUNT_MISMATCH` | Same `payment_intent_id`, different amounts | Currency conversion rounding; partial capture; bug in amount mapping |

## Reconciliation Algorithm

```
internalMap  = { paymentIntentId → { paymentId, amount, currency } }
externalMap  = { paymentIntentId → { chargeId,  amount, currency } }

mismatches = []

// Pass 1: find charges in Stripe with no DB record
for each (piId, ext) in externalMap:
    if piId NOT in internalMap:
        mismatches.push(MISSING_IN_DB)

// Pass 2: find DB records with no Stripe charge, and amount mismatches
for each (piId, int) in internalMap:
    ext = externalMap.get(piId)
    if ext is null:
        mismatches.push(MISSING_IN_STRIPE)
    else if ext.amount != int.amount:
        mismatches.push(AMOUNT_MISMATCH)
```

Time complexity: **O(n + m)** — two hash map lookups, no nested loops.

## Async Generator for Stripe Pagination

Stripe charges are fetched via an **async generator** (`listChargesForDateRange`) that transparently handles cursor-based pagination:

```typescript
async function* listChargesForDateRange(from: number, to: number) {
  let startingAfter: string | undefined;
  do {
    const page = await stripe.charges.list({ created: { gte: from, lte: to },
                                             limit: 100, starting_after: startingAfter });
    for (const charge of page.data) yield charge;
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
  } while (startingAfter);
}
```

This streams charges lazily — memory usage is bounded to one page (100 charges) at a time regardless of how many charges exist.

## Triggering Reconciliation

| Method | When |
|---|---|
| Automatic | Cron runs daily at 2 AM for the previous day |
| Manual | `POST /v1/reconciliation/trigger` with `{ "date": "YYYY-MM-DD" }` |
| CLI | `npm run reconcile [YYYY-MM-DD]` from the scripts directory |

## Reviewing Results

```
GET /v1/reconciliation/:date          — full report with all mismatch details
GET /v1/reconciliation               — list of all past reports (status, counts)
```

## Prometheus Metrics

| Metric | Labels | Meaning |
|---|---|---|
| `reconciliation_mismatch_total` | `type` | Count of each mismatch type found |
| `reconciliation_duration_seconds` | — | Time each run takes end-to-end |
| `reconciliation_last_run_timestamp` | — | Unix timestamp of the last completed run (Grafana: alert if stale) |
