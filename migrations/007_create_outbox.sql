-- Transactional outbox: guarantees at-least-once Kafka delivery
-- Written in same DB transaction as the domain event; relayed to Kafka asynchronously
CREATE TABLE IF NOT EXISTS outbox (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type VARCHAR(50)  NOT NULL,   -- 'payment', 'refund', etc.
  aggregate_id   UUID        NOT NULL,
  topic          VARCHAR(255) NOT NULL,
  event_type     VARCHAR(100) NOT NULL,
  payload        JSONB        NOT NULL,
  headers        JSONB        NOT NULL DEFAULT '{}',
  status         VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED')),
  retry_count    INT          NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  processed_at   TIMESTAMPTZ,
  last_error     TEXT
);

-- Relay sweep queries pending rows ordered by creation time
CREATE INDEX IF NOT EXISTS idx_outbox_pending    ON outbox (status, created_at ASC) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate  ON outbox (aggregate_type, aggregate_id);
