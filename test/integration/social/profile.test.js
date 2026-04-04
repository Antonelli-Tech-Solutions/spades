/**
 * Integration tests for the player profile endpoint.
 * Requires a real PostgreSQL instance via DATABASE_URL.
 * Tests are skipped when DATABASE_URL is not set.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { handler } from '../../../server/server.js'
import { getDb, closeDb } from '../../../server/db.js'

const skip = !process.env.DATABASE_URL ? 'DATABASE_URL not set' : false

async function startTestServer() {
  const app = express()
  app.use(express.json())
  handler(app)

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      })
    })
  })
}

async function resetTestSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS players (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_verified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS player_profiles (
      player_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      avatar_icon SMALLINT NOT NULL DEFAULT 1,
      felt_color VARCHAR(20) NOT NULL DEFAULT 'green',
      card_back VARCHAR(20) NOT NULL DEFAULT 'standard-red',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS games (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      score_ns INTEGER NOT NULL DEFAULT 0,
      score_ew INTEGER NOT NULL DEFAULT 0
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS game_players (
      game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      seat VARCHAR(10) NOT NULL,
      team CHAR(2) NOT NULL,
      won BOOLEAN NOT NULL,
      PRIMARY KEY (game_id, player_id)
    )
  `)
  await db.query(`DELETE FROM game_players WHERE player_id IN (
    SELECT id FROM players WHERE email LIKE '%@test.spades.invalid'
  )`)
  await db.query(`DELETE FROM player_profiles WHERE player_id IN (
    SELECT id FROM players WHERE email LIKE '%@test.spades.invalid'
  )`)
  await db.query(`DELETE FROM players WHERE email LIKE '%@test.spades.invalid'`)
}

async function insertTestPlayer(db, { email, username }) {
  const result = await db.query(
    `INSERT INTO players (email, username, password_hash, is_verified)
     VALUES ($1, $2, 'hash', TRUE) RETURNING id`,
    [email, username],
  )
  return result.rows[0].id
}

async function insertTestGame(db, playerId, { won, scoreNs, scoreEw, seat, completedAt }) {
  const gameResult = await db.query(
    `INSERT INTO games (score_ns, score_ew, completed_at) VALUES ($1, $2, $3) RETURNING id`,
    [scoreNs, scoreEw, completedAt ?? new Date()],
  )
  const gameId = gameResult.rows[0].id
  const team = seat === 'north' || seat === 'south' ? 'ns' : 'ew'
  await db.query(
    `INSERT INTO game_players (game_id, player_id, seat, team, won) VALUES ($1, $2, $3, $4, $5)`,
    [gameId, playerId, seat, team, won],
  )
  return gameId
}

describe('GET /api/profile/:playerId', { skip }, () => {
  let server
  let db

  before(async () => {
    db = getDb()
    await resetTestSchema(db)
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    await closeDb()
  })

  it('returns 200 with profile data for a known player', { timeout: 10000 }, async () => {
    const playerId = await insertTestPlayer(db, {
      email: 'profile_basic@test.spades.invalid',
      username: 'profile_basic',
    })

    const res = await fetch(`${server.baseUrl}/api/profile/${playerId}`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.playerId, playerId)
    assert.equal(body.username, 'profile_basic')
    assert.ok(body.avatar, 'response should include avatar')
    assert.ok(body.cosmetics, 'response should include cosmetics')
    assert.ok(body.career, 'response should include career')
    assert.ok(Array.isArray(body.recentGames), 'recentGames should be an array')
  })

  it('returns default avatar and cosmetics for a player with no profile record', { timeout: 10000 }, async () => {
    const playerId = await insertTestPlayer(db, {
      email: 'profile_defaults@test.spades.invalid',
      username: 'profile_defaults',
    })

    const res = await fetch(`${server.baseUrl}/api/profile/${playerId}`)
    const body = await res.json()

    assert.equal(body.avatar.icon, 1)
    assert.equal(body.cosmetics.feltColor, 'green')
    assert.equal(body.cosmetics.cardBack, 'standard-red')
  })

  it('returns custom avatar and cosmetics when a profile record exists', { timeout: 10000 }, async () => {
    const playerId = await insertTestPlayer(db, {
      email: 'profile_custom@test.spades.invalid',
      username: 'profile_custom',
    })
    await db.query(
      `INSERT INTO player_profiles (player_id, avatar_icon, felt_color, card_back)
       VALUES ($1, $2, $3, $4)`,
      [playerId, 5, 'navy', 'minimal'],
    )

    const res = await fetch(`${server.baseUrl}/api/profile/${playerId}`)
    const body = await res.json()

    assert.equal(body.avatar.icon, 5)
    assert.equal(body.cosmetics.feltColor, 'navy')
    assert.equal(body.cosmetics.cardBack, 'minimal')
  })

  it('returns correct career win/loss counts', { timeout: 10000 }, async () => {
    const playerId = await insertTestPlayer(db, {
      email: 'profile_career@test.spades.invalid',
      username: 'profile_career',
    })
    await insertTestGame(db, playerId, { won: true, scoreNs: 260, scoreEw: 150, seat: 'north' })
    await insertTestGame(db, playerId, { won: true, scoreNs: 270, scoreEw: 100, seat: 'south' })
    await insertTestGame(db, playerId, { won: false, scoreNs: 120, scoreEw: 260, seat: 'north' })

    const res = await fetch(`${server.baseUrl}/api/profile/${playerId}`)
    const body = await res.json()

    assert.equal(body.career.wins, 2)
    assert.equal(body.career.losses, 1)
  })

  it('returns zero wins and losses for a player with no games', { timeout: 10000 }, async () => {
    const playerId = await insertTestPlayer(db, {
      email: 'profile_nogames@test.spades.invalid',
      username: 'profile_nogames',
    })

    const res = await fetch(`${server.baseUrl}/api/profile/${playerId}`)
    const body = await res.json()

    assert.equal(body.career.wins, 0)
    assert.equal(body.career.losses, 0)
    assert.deepEqual(body.recentGames, [])
  })

  it('returns at most 20 recent games ordered most recent first', { timeout: 10000 }, async () => {
    const playerId = await insertTestPlayer(db, {
      email: 'profile_history@test.spades.invalid',
      username: 'profile_history',
    })
    // Insert 25 games with distinct timestamps
    for (let i = 0; i < 25; i++) {
      const completedAt = new Date(Date.now() - i * 60 * 1000) // i minutes ago
      await insertTestGame(db, playerId, {
        won: i % 2 === 0,
        scoreNs: 260,
        scoreEw: 150,
        seat: 'north',
        completedAt,
      })
    }

    const res = await fetch(`${server.baseUrl}/api/profile/${playerId}`)
    const body = await res.json()

    assert.equal(body.recentGames.length, 20)
    // Verify ordering: most recent first
    for (let i = 0; i < body.recentGames.length - 1; i++) {
      const a = new Date(body.recentGames[i].playedAt)
      const b = new Date(body.recentGames[i + 1].playedAt)
      assert.ok(a >= b, 'games should be ordered most recent first')
    }
  })

  it('recent games include gameId, playedAt, won, scoreNs, scoreEw, seat', { timeout: 10000 }, async () => {
    const playerId = await insertTestPlayer(db, {
      email: 'profile_gamefields@test.spades.invalid',
      username: 'profile_gamefields',
    })
    await insertTestGame(db, playerId, { won: true, scoreNs: 260, scoreEw: 150, seat: 'east' })

    const res = await fetch(`${server.baseUrl}/api/profile/${playerId}`)
    const body = await res.json()

    assert.equal(body.recentGames.length, 1)
    const game = body.recentGames[0]
    assert.ok(game.gameId, 'game should have gameId')
    assert.ok(game.playedAt, 'game should have playedAt')
    assert.equal(game.won, true)
    assert.equal(game.scoreNs, 260)
    assert.equal(game.scoreEw, 150)
    assert.equal(game.seat, 'east')
  })

  it('returns 404 for an unknown playerId', { timeout: 10000 }, async () => {
    const res = await fetch(
      `${server.baseUrl}/api/profile/00000000-0000-4000-8000-000000000000`,
    )
    assert.equal(res.status, 404)
  })

  it('returns 400 for a non-UUID playerId', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/profile/not-a-uuid`)
    assert.equal(res.status, 400)
  })
})
