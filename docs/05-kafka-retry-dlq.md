# Kafka Retry & Dead-Letter Queue Architecture

Three-path routing for every Kafka message failure. Implements Figure 12 from the Pragmatic Engineer payment systems article.

```mermaid
flowchart TD
    MSG(["Kafka Message\narrives on partition"]) --> HANDLER["Consumer Handler\neg. handlePaymentCompleted()"]

    HANDLER --> OK{Handler\nsucceeded?}

    OK -->|"Yes"| COMMIT_OK["commitOffset\nPartition moves forward"]

    OK -->|"No — exception thrown"| CLASSIFY{RetryableError\nthrown?}

    CLASSIFY -->|"Non-retryable\neg. bad JSON, business rule violation"| DLQ_NOW["Publish to\noriginalTopic.dlq\nimmediately"]

    CLASSIFY -->|"RetryableError\neg. downstream service unavailable"| BUDGET{Retries\nremaining?\nmax = 3}

    BUDGET -->|"Exhausted after\n3 attempts"| DLQ_NOW

    BUDGET -->|"Retries left"| SCHEDULE["Schedule via Outbox\n─────────────────────────\nAttempt 1 → +1 minute\nAttempt 2 → +5 minutes\nAttempt 3 → +30 minutes\nPersisted in DB before offset commit"]

    SCHEDULE --> COMMIT_R["commitOffset\nPartition unblocked\nno blocking wait"]

    SCHEDULE --> OUTBOX[("outbox table\nscheduled_at = future timestamp")]
    OUTBOX --> RELAY["OutboxRelay polls\nuntil scheduled_at <= NOW()"]
    RELAY --> RETRY_T["payment.retry topic\nheaders: x-retry-count, x-original-topic"]
    RETRY_T --> RETRY_C["Retry Consumer\nre-dispatches to\noriginal handler function"]
    RETRY_C --> HANDLER

    DLQ_NOW --> COMMIT_D["commitOffset"]
    DLQ_NOW --> DLQ_T["originalTopic.dlq\neg. payment.completed.dlq"]
    DLQ_T --> DLQ_C["DLQ Consumer"]
    DLQ_C --> DLQ_DB[("dead_letter_messages\nstatus=OPEN")]
    DLQ_C --> ALERT["Slack Alert\nseverity: critical\ntopic, partition, offset, paymentId, error"]
    DLQ_C --> PROM["Prometheus counter\ndlq_messages_total{topic}"]

    DLQ_DB --> ADMIN["Operator Actions\n────────────────────────\nGET  /admin/dlq\nPOST /admin/dlq/:id/replay\nPOST /admin/dlq/:id/discard"]
    ADMIN -->|"replay: re-publish to original topic"| RETRY_T

    style DLQ_NOW fill:#ff6b6b,color:#fff
    style DLQ_T fill:#ff6b6b,color:#fff
    style DLQ_C fill:#ff6b6b,color:#fff
    style ALERT fill:#ff6b6b,color:#fff
    style SCHEDULE fill:#ffd93d
    style RETRY_T fill:#ffd93d
    style RETRY_C fill:#ffd93d
    style OUTBOX fill:#ffd93d
    style COMMIT_OK fill:#6bcb77
    style COMMIT_R fill:#6bcb77
    style COMMIT_D fill:#6bcb77
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
