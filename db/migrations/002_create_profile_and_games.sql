-- Migration 002: player profiles, games, and game_players
-- Run once against the primary database before starting the server.

CREATE TABLE IF NOT EXISTS player_profiles (
  player_id   UUID        PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  avatar_icon SMALLINT    NOT NULL DEFAULT 1,
  felt_color  VARCHAR(20) NOT NULL DEFAULT 'green',
  card_back   VARCHAR(20) NOT NULL DEFAULT 'standard-red',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS games (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  score_ns     INTEGER     NOT NULL DEFAULT 0,
  score_ew     INTEGER     NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS game_players (
  game_id   UUID       NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id UUID       NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seat      VARCHAR(10) NOT NULL,
  team      CHAR(2)    NOT NULL,
  won       BOOLEAN    NOT NULL,
  PRIMARY KEY (game_id, player_id)
);

-- Index for fast profile lookups by player
CREATE INDEX IF NOT EXISTS idx_game_players_player_id ON game_players(player_id);
