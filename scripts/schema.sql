-- On My Tab: spend-cap ledger and SERV cache (Postgres / Neon). Run each statement once.
CREATE TABLE IF NOT EXISTS settlements (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL,
  sku text NOT NULL,
  visitor text NOT NULL,              -- salted hash of the client IP, never the raw IP
  amount_atomic bigint NOT NULL CHECK (amount_atomic > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled', 'failed')),
  tx text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (run_id, sku)
);
CREATE INDEX IF NOT EXISTS settlements_created_idx ON settlements (created_at);
CREATE INDEX IF NOT EXISTS settlements_visitor_idx ON settlements (visitor, created_at);

CREATE TABLE IF NOT EXISTS serv_cache (
  key text PRIMARY KEY,               -- sha256(normalised want + live quotes)
  plan jsonb NOT NULL,
  meta jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS serv_calls (
  id bigserial PRIMARY KEY,
  visitor text NOT NULL,
  ok boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS serv_calls_created_idx ON serv_calls (created_at);
