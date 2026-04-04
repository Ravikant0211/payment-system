-- Add scheduled_at to outbox so delayed retries survive process restarts.
-- The relay only publishes rows where scheduled_at <= NOW().
ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Replace the existing index so the relay sweep filters by scheduled_at
DROP INDEX IF EXISTS idx_outbox_pending;

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox (status, scheduled_at ASC)
  WHERE status = 'PENDING';
