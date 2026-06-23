CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS guests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR NOT NULL UNIQUE,
  loyalty_code CHAR(4) NOT NULL UNIQUE,
  name VARCHAR NOT NULL,
  birthday DATE,
  total_spent INTEGER NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0,
  level VARCHAR NOT NULL DEFAULT 'guest',
  last_visit TIMESTAMPTZ,
  tg_id BIGINT UNIQUE,
  tg_card_message_id INTEGER,
  card_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE guests ADD COLUMN IF NOT EXISTS tg_card_message_id INTEGER;

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  type VARCHAR NOT NULL,
  amount INTEGER NOT NULL,
  points INTEGER NOT NULL,
  barista_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pending_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id UUID NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  points INTEGER NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'pending',
  barista_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS baristas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR NOT NULL,
  login VARCHAR NOT NULL UNIQUE,
  password_hash VARCHAR NOT NULL,
  role VARCHAR NOT NULL DEFAULT 'barista',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transactions_guest_created_idx ON transactions(guest_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pending_guest_status_idx ON pending_transactions(guest_id, status);
CREATE INDEX IF NOT EXISTS guests_phone_last4_idx ON guests(right(phone, 4));
