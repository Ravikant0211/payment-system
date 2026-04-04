-- Chart of accounts (seeded with system accounts)
CREATE TABLE IF NOT EXISTS accounts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  code           VARCHAR(20)  NOT NULL UNIQUE,  -- e.g. 'RECEIVABLE', 'REVENUE'
  name           VARCHAR(100) NOT NULL,
  account_type   VARCHAR(20)  NOT NULL
                 CHECK (account_type IN ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE', 'EQUITY')),
  normal_balance VARCHAR(6)   NOT NULL
                 CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed system accounts
INSERT INTO accounts (code, name, account_type, normal_balance) VALUES
  ('RECEIVABLE',      'Accounts Receivable',   'ASSET',     'DEBIT'),
  ('MERCHANT_PAYABLE','Merchant Payable',       'LIABILITY', 'CREDIT'),
  ('REVENUE',         'Payment Revenue',        'REVENUE',   'CREDIT'),
  ('STRIPE_FEE',      'Stripe Processing Fees', 'EXPENSE',   'DEBIT'),
  ('REFUND_EXPENSE',  'Refund Expense',         'EXPENSE',   'DEBIT')
ON CONFLICT (code) DO NOTHING;

-- Double-entry ledger entries
-- Every financial event produces exactly two rows (one DEBIT, one CREDIT)
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  UUID        NOT NULL,        -- groups the debit/credit pair
  payment_id      UUID        NOT NULL REFERENCES payments (id),
  account_id      UUID        NOT NULL REFERENCES accounts (id),
  entry_side      VARCHAR(6)  NOT NULL CHECK (entry_side IN ('DEBIT', 'CREDIT')),
  amount          BIGINT      NOT NULL CHECK (amount > 0),
  currency        CHAR(3)     NOT NULL,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_payment_id     ON ledger_entries (payment_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transaction_id ON ledger_entries (transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account_id     ON ledger_entries (account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created_at     ON ledger_entries (created_at DESC);

-- Trigger: enforce that each transaction_id has balanced debit = credit totals
CREATE OR REPLACE FUNCTION check_ledger_balance() RETURNS TRIGGER AS $$
DECLARE
  debit_sum  BIGINT;
  credit_sum BIGINT;
BEGIN
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE entry_side = 'DEBIT'), 0),
    COALESCE(SUM(amount) FILTER (WHERE entry_side = 'CREDIT'), 0)
  INTO debit_sum, credit_sum
  FROM ledger_entries
  WHERE transaction_id = NEW.transaction_id;

  -- Only enforce after we expect both sides to be present (2+ rows)
  IF (SELECT COUNT(*) FROM ledger_entries WHERE transaction_id = NEW.transaction_id) >= 2 THEN
    IF debit_sum <> credit_sum THEN
      RAISE EXCEPTION 'Ledger imbalance for transaction %: debit=% credit=%',
        NEW.transaction_id, debit_sum, credit_sum;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_balance
  AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION check_ledger_balance();
