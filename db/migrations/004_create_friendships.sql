-- Migration: create or migrate friendships table
--
-- The table was originally created (issue #600) with columns player_id / friend_id.
-- Issue #607 renamed them to requester_id / addressee_id and added updated_at.
-- This migration handles both fresh installs and upgrades from the old schema.

DO $$
BEGIN
  -- If the table does not exist, create it with the new schema.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'friendships') THEN
    CREATE TABLE friendships (
      id BIGSERIAL PRIMARY KEY,
      requester_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      addressee_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT friendships_pair_unique UNIQUE (requester_id, addressee_id)
    );
  ELSE
    -- Migrate from old schema if needed: rename columns
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'friendships' AND column_name = 'player_id'
    ) THEN
      ALTER TABLE friendships RENAME COLUMN player_id TO requester_id;
      ALTER TABLE friendships RENAME COLUMN friend_id TO addressee_id;
    END IF;

    -- Add updated_at column if missing
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'friendships' AND column_name = 'updated_at'
    ) THEN
      ALTER TABLE friendships ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    END IF;

    -- Drop old unique constraint if it exists and add new one
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'friendships' AND constraint_name = 'friendships_player_id_friend_id_key'
    ) THEN
      ALTER TABLE friendships DROP CONSTRAINT friendships_player_id_friend_id_key;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'friendships' AND constraint_name = 'friendships_pair_unique'
    ) THEN
      ALTER TABLE friendships ADD CONSTRAINT friendships_pair_unique UNIQUE (requester_id, addressee_id);
    END IF;
  END IF;
END
$$;
