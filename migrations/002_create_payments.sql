-- Payments: primary record for each payment attempt
CREATE TABLE IF NOT EXISTS payments (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id             UUID        NOT NULL REFERENCES merchants (id),
  order_id                VARCHAR(255) NOT NULL,
  customer_id             VARCHAR(255) NOT NULL,
  idempotency_key         VARCHAR(255) NOT NULL,
  amount                  BIGINT      NOT NULL CHECK (amount > 0),  -- minor units (cents/paise)
  currency                CHAR(3)     NOT NULL,
  payment_method          VARCHAR(30)  NOT NULL
                          CHECK (payment_method IN ('CREDIT_CARD', 'DEBIT_CARD', 'UPI', 'NET_BANKING')),
  status                  VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED','REFUNDED','EXPIRED','CANCELLED')),
  stripe_session_id       VARCHAR(255),
  stripe_payment_intent_id VARCHAR(255),
  checkout_url            TEXT,
  failure_reason          TEXT,
  retry_count             INT          NOT NULL DEFAULT 0,
  success_url             TEXT         NOT NULL,
  cancel_url              TEXT         NOT NULL,
  metadata                JSONB        NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Unique idempotency per merchant
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_merchant_idempotency
  ON payments (merchant_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_payments_merchant_id     ON payments (merchant_id);
CREATE INDEX IF NOT EXISTS idx_payments_status          ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_stripe_session  ON payments (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_created_at      ON payments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_order_id        ON payments (order_id);

-- Payment events: immutable audit trail for every status transition
CREATE TABLE IF NOT EXISTS payment_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  UUID        NOT NULL REFERENCES payments (id),
  event_type  VARCHAR(100) NOT NULL,
  old_status  VARCHAR(20),
  new_status  VARCHAR(20),
  actor       VARCHAR(100),  -- 'system', 'webhook', 'merchant', etc.
  payload     JSONB        NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_payment_id ON payment_events (payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_created_at ON payment_events (created_at DESC);

-- Idempotency keys: durable fallback when Redis is cold
CREATE TABLE IF NOT EXISTS idempotency_keys (
  merchant_id     UUID        NOT NULL REFERENCES merchants (id),
  idempotency_key VARCHAR(255) NOT NULL,
  payment_id      UUID        REFERENCES payments (id),
  request_hash    VARCHAR(64)  NOT NULL,
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  PRIMARY KEY (merchant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);
