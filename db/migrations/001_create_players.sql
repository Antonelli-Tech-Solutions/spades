-- Migration 001: players and email verification tokens
-- Run once against the primary database before starting the server.

CREATE TABLE IF NOT EXISTS players (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  username      VARCHAR(50)  UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_verified   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token      UUID        PRIMARY KEY,
  player_id  UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast token lookup during email verification
CREATE INDEX IF NOT EXISTS idx_evt_player_id ON email_verification_tokens(player_id);
