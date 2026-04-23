# Kafka Retry & Dead-Letter Queue Architecture

Three-path routing for every Kafka message failure. Implements Figure 12 from the Pragmatic Engineer payment systems article.

```mermaid
flowchart TD
    MSG(["Kafka Message<br/>arrives on partition"]) --> HANDLER["Consumer Handler<br/>eg. handlePaymentCompleted()"]

    HANDLER --> OK{"Handler<br/>succeeded?"}

    OK -->|"Yes"| COMMIT_OK["commitOffset<br/>Partition moves forward"]

    OK -->|"No — exception thrown"| CLASSIFY{"RetryableError<br/>thrown?"}

    CLASSIFY -->|"Non-retryable<br/>eg. bad JSON, business rule violation"| DLQ_NOW["Publish to<br/>originalTopic.dlq<br/>immediately"]

    CLASSIFY -->|"RetryableError<br/>eg. downstream service unavailable"| BUDGET{"Retries<br/>remaining?<br/>max = 3"}

    BUDGET -->|"Exhausted after<br/>3 attempts"| DLQ_NOW

    BUDGET -->|"Retries left"| SCHEDULE["Schedule via Outbox<br/>─────────────────────────<br/>Attempt 1 → +1 minute<br/>Attempt 2 → +5 minutes<br/>Attempt 3 → +30 minutes<br/>Persisted in DB before offset commit"]

    SCHEDULE --> COMMIT_R["commitOffset<br/>Partition unblocked<br/>no blocking wait"]

    SCHEDULE --> OUTBOX[("outbox table<br/>scheduled_at = future timestamp")]
    OUTBOX --> RELAY["OutboxRelay polls<br/>until scheduled_at &lt;= NOW()"]
    RELAY --> RETRY_T["payment.retry topic<br/>headers: x-retry-count, x-original-topic"]
    RETRY_T --> RETRY_C["Retry Consumer<br/>re-dispatches to<br/>original handler function"]
    RETRY_C --> HANDLER

    DLQ_NOW --> COMMIT_D["commitOffset"]
    DLQ_NOW --> DLQ_T["originalTopic.dlq<br/>eg. payment.completed.dlq"]
    DLQ_T --> DLQ_C["DLQ Consumer"]
    DLQ_C --> DLQ_DB[("dead_letter_messages<br/>status=OPEN")]
    DLQ_C --> ALERT["Slack Alert<br/>severity: critical<br/>topic, partition, offset, paymentId, error"]
    DLQ_C --> PROM["Prometheus counter<br/>dlq_messages_total{topic}"]

    DLQ_DB --> ADMIN["Operator Actions<br/>────────────────────────<br/>GET  /admin/dlq<br/>POST /admin/dlq/:id/replay<br/>POST /admin/dlq/:id/discard"]
    ADMIN -->|"replay: re-publish to original topic"| RETRY_T

    classDef default fill:#ffffff,stroke:#37474F,color:#000000
    classDef decision fill:#E1F5FE,stroke:#0277BD,color:#01579B
    classDef danger fill:#EF5350,stroke:#B71C1C,color:#FFFFFF
    classDef warn fill:#FFD93D,stroke:#F57F17,color:#000000
    classDef success fill:#66BB6A,stroke:#1B5E20,color:#000000
    classDef info fill:#E3F2FD,stroke:#1565C0,color:#0D47A1

    class OK,CLASSIFY,BUDGET decision
    class DLQ_NOW,DLQ_T,DLQ_C,ALERT danger
    class SCHEDULE,RETRY_T,RETRY_C,OUTBOX warn
    class COMMIT_OK,COMMIT_R,COMMIT_D success
    class MSG,HANDLER,RELAY,DLQ_DB,PROM,ADMIN info
```

## Three Routing Paths

### Path 1 — Success
Handler completes without throwing. Offset is committed. Partition advances normally.

### Path 2 — Retryable Failure (`RetryableError`)
Thrown by handler code for **transient** failures (downstream service temporarily down, network timeout, rate limit). The message is **not** retried inline — that would block the partition for up to 30 minutes.

Instead, the retry is **durable**:
1. Write retry payload + `scheduled_at` to the `outbox` table (inside a DB write, before committing the Kafka offset).
2. Commit the Kafka offset — the partition is immediately free for the next message.
3. The `OutboxRelay` polls `outbox` until `scheduled_at <= NOW()`, then publishes to `payment.retry`.
4. The retry consumer reads from `payment.retry` and calls the same handler function.
5. If that attempt also throws `RetryableError`, the retry count increments and it loops back (up to `maxRetries`).
6. Once `maxRetries` is exhausted, the message is routed to the DLQ.

**Retry delay schedule** (exponential, durable):

| Attempt | Delay |
|---------|-------|
| 1st retry | +1 minute |
| 2nd retry | +5 minutes |
| 3rd retry | +30 minutes |
| Exhausted | → DLQ |

### Path 3 — Non-Retryable Failure
Any exception that is **not** a `RetryableError` (e.g. `JSON.parse` fails, a business rule is violated). No retry is attempted — retrying would just fail again. The message goes directly to the DLQ.

## Why Durable Retries via Outbox?

The naive approach — retrying inline with `await sleep(delay)` — has two problems:
1. **Blocked partition**: the consumer holds the partition for the entire delay window (up to 30 min), preventing other messages from being processed.
2. **Lost on crash**: if the process restarts during the delay, the retry is silently dropped.

The outbox-based approach solves both: the partition is freed immediately, and the retry survives any process crash because it is persisted in PostgreSQL before the offset is committed.

## Kafka Topics

```
payment.initiated          ← payment created, checkout session opened
payment.completed          ← payment confirmed via Stripe webhook
payment.failed             ← payment failed or expired
payment.expired            ← checkout session expired
payment.retry              ← durable retry queue (all topics share one retry queue)
payment.initiated.dlq      ← dead letters from payment.initiated processing
payment.completed.dlq      ← dead letters from payment.completed processing
payment.failed.dlq         ← dead letters from payment.failed processing
payment.retry.dlq          ← dead letters after all retry attempts exhausted
reconciliation.done        ← nightly reconciliation result
```

## Error Classification Guide

| Throw | When |
|-------|------|
| `RetryableError` | Downstream HTTP 503/429, network timeout, temporary DB unavailability |
| Any other `Error` | Invalid message payload, business rule violation, permanent data issue |
