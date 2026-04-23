# Payment Creation Flow

Full sequence from `POST /v1/payments` through idempotency checks, Stripe session creation, database commit, and Kafka publish via the Outbox Pattern.

```mermaid
sequenceDiagram
    actor Client
    participant MW as Middleware<br/>(Auth + Idempotency)
    participant SVC as PaymentService
    participant DB as PostgreSQL
    participant R as Redis
    participant ST as Stripe
    participant OR as OutboxRelay
    participant KF as Kafka

    Client->>MW: POST /v1/payments<br/>Authorization: Bearer api_key<br/>Idempotency-Key: uuid<br/>Body: { amount, currency, method, successUrl, cancelUrl }

    MW->>R: Lua SET NX EX 86400 (idempotency key)
    alt Key already exists — duplicate request
        R-->>MW: HIT
        MW-->>Client: 200 Cached response (no DB hit)
    else New key — proceed
        R-->>MW: MISS

        MW->>R: GET merchant cache (api_key_hash)
        alt Cache miss
            MW->>DB: SELECT merchants WHERE api_key_hash = HMAC-SHA256(key)
            DB-->>MW: Merchant row
            MW->>R: SET merchant cache (10 min TTL)
        else Cache hit
            R-->>MW: Merchant row
        end

        MW->>SVC: createPayment(merchantId, input)

        SVC->>DB: BEGIN TRANSACTION

        SVC->>DB: INSERT payments<br/>status=PENDING, amount, currency,<br/>payment_method, success_url, cancel_url,<br/>idempotency_key, metadata
        DB-->>SVC: payment { id }

        SVC->>ST: checkout.sessions.create()<br/>retryWithBackoff — 3 attempts<br/>delays: 500ms → 2s → 4s + jitter<br/>retries: network errors, 429, 5xx only<br/>never retries: 4xx (bad request)
        ST-->>SVC: { id: cs_xxx, url: https://checkout.stripe.com/... }

        SVC->>DB: UPDATE payments<br/>SET status=PROCESSING,<br/>stripe_session_id=cs_xxx,<br/>checkout_url=stripe_url

        SVC->>DB: INSERT outbox<br/>topic=payment.initiated<br/>payload={ eventType, paymentId, amount... }<br/>status=PENDING, scheduled_at=NOW()

        SVC->>DB: COMMIT

        SVC-->>MW: { paymentId, checkoutUrl }
        MW->>R: Cache response body + status code
        MW-->>Client: 201 { data: { paymentId, checkoutUrl } }

        Note over Client: Client redirects user to Stripe-hosted checkout page.<br/>Stripe handles card entry, UPI flow, net banking redirect.

        loop OutboxRelay — every 500ms
            OR->>DB: SELECT * FROM outbox<br/>WHERE status=PENDING<br/>AND scheduled_at &lt;= NOW()<br/>ORDER BY created_at<br/>FOR UPDATE SKIP LOCKED
            DB-->>OR: Pending outbox rows
            OR->>KF: publish payment.initiated<br/>with traceId + correlationId headers<br/>(inner retryWithBackoff: 2 attempts)
            OR->>DB: UPDATE outbox SET status=SENT, sent_at=NOW()
        end
    end
```

## Critical Properties

### Atomicity (Transactional Outbox Pattern)
The DB transaction contains **three writes in one commit**:
1. `payments` row
2. Stripe session creation result written back to `payments`
3. `outbox` row

If the process crashes after COMMIT, the OutboxRelay will still publish the Kafka message on restart — because the outbox row survived. There is no window where a payment exists in DB but no Kafka event is ever published.

### Idempotency (Two Layers)
- **Layer 1 — Redis** (`SET NX EX`): atomic Lua script, prevents concurrent duplicate processing.
- **Layer 2 — PostgreSQL** (`UNIQUE INDEX ON payments(merchant_id, idempotency_key)`): survives a Redis restart; the DB will reject a duplicate `INSERT` even if Redis was wiped.

### Stripe Retry Logic
`retryWithBackoff` in `stripe-checkout.ts` wraps `stripe.checkout.sessions.create()`:
- Max 3 attempts, base delay 500ms, max 4s, jitter factor 0.3
- Only retries: network errors, HTTP 429, HTTP 5xx
- Never retries: HTTP 4xx (bad request data — retrying won't help)
- Stripe SDK itself adds `maxNetworkRetries: 3` at the transport level as an additional safety net

### `FOR UPDATE SKIP LOCKED`
Allows multiple OutboxRelay instances (horizontal scaling) to claim different rows simultaneously without blocking each other.
