-- Refunds
CREATE TABLE IF NOT EXISTS refunds (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id       UUID        NOT NULL REFERENCES payments (id),
  amount           BIGINT      NOT NULL CHECK (amount > 0),
  currency         CHAR(3)     NOT NULL,
  reason           VARCHAR(100),
  stripe_refund_id VARCHAR(255) UNIQUE,
  status           VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  failure_reason   TEXT,
  metadata         JSONB        NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refunds_payment_id ON refunds (payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_status     ON refunds (status);
