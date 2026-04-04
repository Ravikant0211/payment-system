# Architecture Diagrams

Visual documentation of the payment system — from high-level design down to internal mechanics.

| # | Document | What it covers |
|---|----------|----------------|
| 1 | [System Architecture](01-system-architecture.md) | All components, external services, and data flow between them |
| 2 | [Code Layers](02-code-layers.md) | Internal layer structure and strict dependency direction |
| 3 | [Payment Creation Flow](03-payment-creation-flow.md) | `POST /v1/payments` → idempotency → Stripe → Outbox → Kafka |
| 4 | [Webhook Processing Flow](04-webhook-processing-flow.md) | Stripe event → dedup → DB transaction → double-entry ledger |
| 5 | [Kafka Retry & DLQ](05-kafka-retry-dlq.md) | Three-path routing: success, durable retry queue, dead-letter |
| 6 | [Stuck Payments Recovery](06-stuck-payments-recovery.md) | Cron polling for missed webhooks; per-method thresholds |
| 7 | [Reconciliation Flow](07-reconciliation-flow.md) | Nightly DB vs Stripe comparison; mismatch alerting |
| 8 | [Database Schema](08-database-schema.md) | All 9 tables, columns, relationships, and key indexes |
| 9 | [Two-Layer Idempotency](09-idempotency.md) | Redis Lua atomic SET NX + PostgreSQL unique index |

## Reading Order

If you are new to this codebase, read in this order:

1. **[System Architecture](01-system-architecture.md)** — understand all the moving parts before diving in.
2. **[Code Layers](02-code-layers.md)** — understand where to find and add code.
3. **[Database Schema](08-database-schema.md)** — the data model underpins every flow.
4. **[Payment Creation Flow](03-payment-creation-flow.md)** — the primary happy path.
5. **[Webhook Processing Flow](04-webhook-processing-flow.md)** — how payments actually complete.
6. **[Two-Layer Idempotency](09-idempotency.md)** — why duplicate charges are impossible.
7. **[Kafka Retry & DLQ](05-kafka-retry-dlq.md)** — how failures are handled reliably.
8. **[Stuck Payments Recovery](06-stuck-payments-recovery.md)** — handling delayed payment methods.
9. **[Reconciliation Flow](07-reconciliation-flow.md)** — the nightly safety net.
