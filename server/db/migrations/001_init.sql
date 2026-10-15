-- Hela schema. Money is always stored as integer minor units (cents)
-- alongside its ISO 4217 currency, never as floating point.

CREATE TABLE students (
  id                    TEXT PRIMARY KEY,
  first_name            TEXT NOT NULL,
  email                 TEXT NOT NULL,
  home_currency         TEXT NOT NULL DEFAULT 'KES',
  -- 0 read only · 1 advise · 2 act with confirmation · 3 act within limits
  tier                  SMALLINT NOT NULL DEFAULT 1 CHECK (tier BETWEEN 0 AND 3),
  per_payment_cap_minor BIGINT NOT NULL,
  daily_cap_minor       BIGINT NOT NULL,
  monthly_cap_minor     BIGINT NOT NULL,
  min_buffer_minor      BIGINT NOT NULL,
  otp_threshold_minor   BIGINT NOT NULL,
  pin_hash              TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  student_id    TEXT NOT NULL REFERENCES students(id),
  kind          TEXT NOT NULL CHECK (kind IN ('mobile_money', 'bank', 'card')),
  label         TEXT NOT NULL,
  currency      TEXT NOT NULL,
  balance_minor BIGINT NOT NULL
);

CREATE TABLE transactions (
  id              TEXT PRIMARY KEY,
  student_id      TEXT NOT NULL REFERENCES students(id),
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  occurred_at     TIMESTAMPTZ NOT NULL,
  -- negative = money out, positive = money in
  amount_minor    BIGINT NOT NULL,
  currency        TEXT NOT NULL,
  payee           TEXT NOT NULL,
  description     TEXT NOT NULL,
  category        TEXT,
  category_source TEXT CHECK (category_source IN ('rule', 'model', 'student'))
);
CREATE INDEX transactions_student_time ON transactions (student_id, occurred_at DESC);

CREATE TABLE category_rules (
  id         SERIAL PRIMARY KEY,
  student_id TEXT REFERENCES students(id), -- NULL = global rule
  pattern    TEXT NOT NULL,                -- case-insensitive substring of payee or description
  category   TEXT NOT NULL
);

CREATE TABLE category_budgets (
  student_id   TEXT NOT NULL REFERENCES students(id),
  category     TEXT NOT NULL,
  monthly_minor BIGINT NOT NULL,
  PRIMARY KEY (student_id, category)
);

CREATE TABLE payees (
  id         TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('university', 'person', 'merchant')),
  country    TEXT NOT NULL,
  currency   TEXT NOT NULL,
  details    JSONB NOT NULL DEFAULT '{}',
  approved   BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id           TEXT PRIMARY KEY,
  student_id   TEXT NOT NULL REFERENCES students(id),
  payee_id     TEXT REFERENCES payees(id),
  issuer       TEXT NOT NULL,
  reference    TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency     TEXT NOT NULL,
  due_date     DATE NOT NULL,
  -- The document text as received. Untrusted: it is shown to the model as data only.
  raw_text     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid'))
);

-- KES per one unit of the foreign currency, one row per day.
CREATE TABLE fx_rates (
  rate_date DATE NOT NULL,
  currency  TEXT NOT NULL,
  kes_per_unit NUMERIC(14, 6) NOT NULL,
  PRIMARY KEY (rate_date, currency)
);

-- Dated, illustrative fee tables for remittance routes (sandbox data).
CREATE TABLE fee_snapshots (
  id                TEXT PRIMARY KEY,
  route_name        TEXT NOT NULL,
  route_kind        TEXT NOT NULL,
  to_currency       TEXT NOT NULL,
  fee_fixed_minor   BIGINT NOT NULL,         -- in KES minor units
  fee_pct           NUMERIC(6, 4) NOT NULL,  -- e.g. 0.0150 = 1.5 %
  fx_margin_pct     NUMERIC(6, 4) NOT NULL,  -- spread below the mid rate
  min_send_minor    BIGINT NOT NULL,
  max_send_minor    BIGINT NOT NULL,
  arrival_hours     INTEGER NOT NULL,
  requires          TEXT[] NOT NULL DEFAULT '{}',
  snapshot_date     DATE NOT NULL
);

CREATE TABLE student_documents (
  student_id TEXT NOT NULL REFERENCES students(id),
  document   TEXT NOT NULL,  -- e.g. 'national_id', 'passport', 'admission_letter'
  PRIMARY KEY (student_id, document)
);

CREATE TABLE plans (
  id         TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id),
  kind       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE proposals (
  id                TEXT PRIMARY KEY,
  student_id        TEXT NOT NULL REFERENCES students(id),
  idempotency_key   TEXT NOT NULL UNIQUE,
  origin            TEXT NOT NULL CHECK (origin IN ('agent', 'schedule')),
  payee_id          TEXT NOT NULL REFERENCES payees(id),
  source_account_id TEXT NOT NULL REFERENCES accounts(id),
  -- What the payee receives
  amount_minor      BIGINT NOT NULL,
  currency          TEXT NOT NULL,
  -- What leaves the student's account, fees included
  debit_minor       BIGINT NOT NULL,
  debit_currency    TEXT NOT NULL,
  fee_minor         BIGINT NOT NULL,
  fx_rate           NUMERIC(14, 6),
  route_id          TEXT REFERENCES fee_snapshots(id),
  invoice_id        TEXT REFERENCES invoices(id),
  memo              TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL CHECK (status IN
                      ('needs_confirmation', 'denied', 'executing', 'executed', 'failed', 'cancelled')),
  decision          JSONB NOT NULL,
  otp_hash          TEXT,
  otp_attempts      INTEGER NOT NULL DEFAULT 0,
  provider          TEXT,
  provider_ref      TEXT,
  failure_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at        TIMESTAMPTZ,
  executed_at       TIMESTAMPTZ
);
CREATE INDEX proposals_student_time ON proposals (student_id, created_at DESC);

CREATE TABLE scheduled_payments (
  id            TEXT PRIMARY KEY,
  student_id    TEXT NOT NULL REFERENCES students(id),
  payee_id      TEXT NOT NULL REFERENCES payees(id),
  source_account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_minor  BIGINT NOT NULL,
  currency      TEXT NOT NULL,
  route_id      TEXT REFERENCES fee_snapshots(id),
  memo          TEXT NOT NULL DEFAULT '',
  interval_days INTEGER NOT NULL CHECK (interval_days > 0),
  next_run      DATE NOT NULL,
  -- A schedule the agent proposes only runs after the student approves it.
  status        TEXT NOT NULL CHECK (status IN ('pending_approval', 'active', 'revoked')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_methods (
  student_id         TEXT PRIMARY KEY REFERENCES students(id),
  provider           TEXT NOT NULL,
  -- Provider token only. Hela never sees or stores a card number or PIN.
  authorization_code TEXT NOT NULL,
  email              TEXT NOT NULL,
  label              TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  student_id TEXT PRIMARY KEY REFERENCES students(id),
  messages   JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only, hash-chained audit log.
CREATE TABLE audit_log (
  seq        BIGSERIAL PRIMARY KEY,
  student_id TEXT,
  at         TIMESTAMPTZ NOT NULL,
  kind       TEXT NOT NULL,
  data       JSONB NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);

CREATE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();
