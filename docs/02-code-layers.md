# Code Architecture — Layer Diagram

Strict dependency direction: **Entry Points → Domain → Common ← Infrastructure**.
Domain code never imports from Infrastructure directly — all I/O adapters are injected via constructors.

```mermaid
graph TB
    subgraph Entry["Entry Points  (src/main.ts → src/app.ts)"]
        HTTP_R["HTTP Routes
        payment · webhook · reconciliation · admin"]
        KAFKA_C["Kafka Consumers
        payment-events · payment-retry · dead-letter · reconciliation"]
        CRON_J["Cron Jobs
        reconciliation · stuck-payments-checker"]
    end

    subgraph Domain["Domain Layer  (src/domains/)"]
        PAY["payment
        ─────────────────
        service · repository
        schemas · entity
        stuck-payments-checker"]
        WH["webhook
        ──────────────────
        service · handlers
        webhook-event.repo"]
        LED["ledger
        ──────────────────
        service · repository
        entity"]
        REC["reconciliation
        ──────────────────
        service · repository
        entity"]
        ADM["admin
        ──────────────────
        admin.routes"]
    end

    subgraph Common["Common  (src/common/)"]
        ERR["errors
        AppError · RetryableError
        NotFound · Validation…"]
        LOG["logger
        Pino + traceId
        (AsyncLocalStorage)"]
        MID["middleware
        authenticate · idempotency
        validate · error-handler"]
        UTILS["utils
        Money · retryWithBackoff
        hashApiKey · crypto"]
    end

    subgraph Infra["Infrastructure  (src/infrastructure/)"]
        DB_I["database
        pg-pool · transaction
        migrator"]
        REDIS_I["redis
        redis-client · lua-scripts"]
        KAFKA_I["kafka
        producer · consumer-manager
        topics"]
        STRIPE_I["stripe
        stripe-checkout · webhook-parser
        reconciliation (async gen)"]
        OUTBOX_I["outbox
        outbox-repository
        outbox-relay"]
        ALERT_I["alerting
        slack-alerter"]
        SCHED_I["scheduler
        cron"]
    end

    HTTP_R --> PAY & WH & REC & LED & ADM
    KAFKA_C --> PAY & REC
    KAFKA_C --> ALERT_I
    CRON_J --> PAY & REC

    PAY & WH & LED & REC --> DB_I & OUTBOX_I
    PAY & WH & REC --> KAFKA_I
    PAY --> STRIPE_I & REDIS_I
    WH --> STRIPE_I
    REC --> STRIPE_I

    MID --> REDIS_I & DB_I

    Domain --> Common
    Entry --> Common

    style Entry fill:#e3f2fd,stroke:#1565C0
    style Domain fill:#f3e5f5,stroke:#6A1B9A
    style Common fill:#fff8e1,stroke:#F57F17
    style Infra fill:#e8f5e9,stroke:#2E7D32
```

## Directory Structure

```
src/
├── main.ts                      # Bootstrap: connects all deps in startup order
├── app.ts                       # Express factory — middleware stack, route mounting
├── config/                      # Env var validation (zod) — crashes on missing vars
├── common/
│   ├── errors/                  # AppError hierarchy + RetryableError marker
│   ├── logger/                  # Pino with AsyncLocalStorage traceId mixin
│   ├── middleware/              # authenticate, idempotency, validate, error-handler
│   ├── tracing/                 # AsyncLocalStorage store for traceId/correlationId
│   └── utils/                  # Money (bigint), retryWithBackoff, crypto
├── domains/
│   ├── payment/                 # Core payment lifecycle
│   ├── webhook/                 # Stripe webhook event processing
│   ├── ledger/                  # Double-entry bookkeeping
│   ├── reconciliation/          # DB vs Stripe nightly comparison
│   └── admin/                   # Ops endpoints (DLQ replay, state dump)
├── kafka/
│   └── consumers/               # Consumer registrations (thin wrappers)
├── infrastructure/
│   ├── database/                # pg-pool, transaction helper, migrator
│   ├── redis/                   # ioredis singleton + Lua atomic scripts
│   ├── kafka/                   # KafkaJS producer, consumer-manager, topics
│   ├── stripe/                  # Stripe SDK wrappers with retry logic
│   ├── outbox/                  # Outbox repository + relay polling loop
│   ├── scheduler/               # node-cron job setup
│   └── alerting/                # Slack webhook sender
└── metrics/                     # Prometheus metric definitions + /metrics endpoint
```

## Dependency Rules

| Layer | Can import from | Cannot import from |
|---|---|---|
| Entry Points | Domain, Common, Infrastructure | — |
| Domain | Common, Infrastructure (injected) | Other Domains directly |
| Common | — | Domain, Infrastructure |
| Infrastructure | Common | Domain |
