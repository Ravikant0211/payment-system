-- Reconciliation reports: one per run (typically nightly)
CREATE TABLE IF NOT EXISTS reconciliation_reports (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date             DATE        NOT NULL UNIQUE,
  status               VARCHAR(20)  NOT NULL DEFAULT 'RUNNING'
                       CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  total_internal       INT          NOT NULL DEFAULT 0,
  total_external       INT          NOT NULL DEFAULT 0,
  matched_count        INT          NOT NULL DEFAULT 0,
  mismatch_count       INT          NOT NULL DEFAULT 0,
  mismatches           JSONB        NOT NULL DEFAULT '[]',
  error                TEXT,
  started_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_run_date ON reconciliation_reports (run_date DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_status   ON reconciliation_reports (status);

-- Dead-letter queue: messages that could not be processed after all retries
CREATE TABLE IF NOT EXISTS dead_letter_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  topic       VARCHAR(255) NOT NULL,
  partition   INT          NOT NULL,
  kafka_offset BIGINT      NOT NULL,
  payment_id  UUID        REFERENCES payments (id),
  event_type  VARCHAR(100),
  payload     JSONB        NOT NULL,
  error       TEXT         NOT NULL,
  retry_count INT          NOT NULL DEFAULT 0,
  status      VARCHAR(20)  NOT NULL DEFAULT 'OPEN'
              CHECK (status IN ('OPEN', 'RESOLVED', 'IGNORED')),
  resolved_at TIMESTAMPTZ,
  notes       TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dlq_status     ON dead_letter_messages (status);
CREATE INDEX IF NOT EXISTS idx_dlq_topic      ON dead_letter_messages (topic);
CREATE INDEX IF NOT EXISTS idx_dlq_payment_id ON dead_letter_messages (payment_id);
