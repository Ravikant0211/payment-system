-- Stripe webhook events: deduplicated by stripe_event_id
CREATE TABLE IF NOT EXISTS webhook_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id VARCHAR(255) NOT NULL UNIQUE,
  event_type      VARCHAR(100) NOT NULL,
  processed       BOOLEAN      NOT NULL DEFAULT FALSE,
  processed_at    TIMESTAMPTZ,
  processing_error TEXT,
  raw_payload     JSONB        NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_stripe_id   ON webhook_events (stripe_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed   ON webhook_events (processed);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at  ON webhook_events (created_at DESC);
