# System Architecture

High-level view of all components, external services, and how data flows between them.

```mermaid
graph TB
    subgraph Clients
        BROWSER["Browser / Mobile App"]
        MERCHANT["Merchant Backend"]
    end

    subgraph PaymentSystem["Payment System (Node.js Monolith)"]
        HTTP["Express HTTP Server :3000
        ─────────────────────
        Routes: /v1/payments
                /v1/reconciliation
                /webhooks/stripe
                /admin
                /metrics"]
        RELAY["Outbox Relay
        (polls every 500ms)"]
        CONSUMERS["Kafka Consumers
        ─────────────────
        payment-events
        payment-retry
        dead-letter
        reconciliation"]
        CRON["Cron Scheduler
        ──────────────────
        Reconciliation: 2 AM
        Stuck payments: 5 min"]
    end

    subgraph DataStores["Data Stores"]
        PG[("PostgreSQL
        ──────────
        payments
        ledger_entries
        outbox
        webhook_events
        dead_letter_messages")]
        REDIS[("Redis
        ──────────────
        Idempotency keys
        API key cache")]
    end

    subgraph MsgBus["Message Bus"]
        KAFKA["Apache Kafka
        ─────────────────────
        payment.initiated
        payment.completed
        payment.failed
        payment.retry
        *.dlq
        reconciliation.done"]
    end

    subgraph External["External Services"]
        STRIPE["Stripe
        ──────────────
        Checkout Sessions
        Webhooks
        Charge listing"]
        SLACK["Slack
        ──────────────
        Ops Alerts"]
    end

    subgraph Observability["Observability"]
        PROM["Prometheus"]
        GRAFANA["Grafana
        Dashboards + Alerts"]
    end

    BROWSER -->|"POST /v1/payments
    GET  /v1/payments/:id"| HTTP
    MERCHANT -->|"API Key Bearer auth"| HTTP
    STRIPE -->|"POST /webhooks/stripe
    (signature verified)"| HTTP

    HTTP <--> PG
    HTTP <--> REDIS
    HTTP -->|"createCheckoutSession
    (retryWithBackoff)"| STRIPE
    HTTP -->|"GET /metrics"| PROM

    PG -->|"poll pending outbox rows
    FOR UPDATE SKIP LOCKED"| RELAY
    RELAY -->|"sendMessage"| KAFKA

    KAFKA -->|"eachMessage"| CONSUMERS
    CONSUMERS <--> PG
    CONSUMERS -->|"critical DLQ / reconciliation alerts"| SLACK

    CRON -->|"runReconciliation()"| PG
    CRON -->|"listChargesForDateRange()"| STRIPE
    CRON -->|"retrieveCheckoutSession()"| STRIPE

    PROM --> GRAFANA

    style PaymentSystem fill:#e8f4fd,stroke:#2196F3
    style DataStores fill:#fff3e0,stroke:#FF9800
    style MsgBus fill:#f3e5f5,stroke:#9C27B0
    style External fill:#e8f5e9,stroke:#4CAF50
    style Observability fill:#fce4ec,stroke:#E91E63
```

## Key Design Decisions

- **Monolith with clear domain boundaries** — single deployable unit, but strict layering enforced by code convention (no cross-domain imports except via injected interfaces).
- **Stripe as hosted PSP** — the payment UI lives on Stripe's servers. The system never handles raw card numbers (PCI scope reduction).
- **Kafka for internal events** — all post-payment processing (analytics, ledger, notifications) is decoupled from the payment creation path via the Outbox Pattern.
- **Dual data stores** — PostgreSQL for durable transactional state, Redis for low-latency idempotency checks and API key caching.
- **Observability first** — every HTTP request, Kafka message, Stripe call, and background job emits Prometheus metrics with labels; Grafana alerts on DLQ depth, reconciliation mismatches, and p99 latency.
