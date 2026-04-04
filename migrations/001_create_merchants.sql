-- Merchants: each merchant has an API key for authentication
CREATE TABLE IF NOT EXISTS merchants (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         VARCHAR(255) NOT NULL,
  email        VARCHAR(255) NOT NULL UNIQUE,
  api_key_hash VARCHAR(64)  NOT NULL UNIQUE,  -- SHA-256 hex
  status       VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
  metadata     JSONB        NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchants_api_key_hash ON merchants (api_key_hash);
CREATE INDEX IF NOT EXISTS idx_merchants_status ON merchants (status);
