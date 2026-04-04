/**
 * Integration tests for GET /api/player/table.
 * Requires a real Redis instance (REDIS_URL) and database (DATABASE_URL).
 * Tests are skipped when either is not set.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import bcrypt from 'bcryptjs'
import { handler } from '../../../server/server.js'
import { getDb, closeDb } from '../../../server/db.js'
import { getRedis, closeRedis } from '../../../server/redis.js'

const skip =
  !process.env.DATABASE_URL || !process.env.REDIS_URL
    ? 'DATABASE_URL and REDIS_URL must both be set'
    : false

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

async function ensurePlayersTable(db) {
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@pttest.spades.invalid'`)
}

async function insertVerifiedPlayer(db, { email, username, password }) {
  const hash = await bcrypt.hash(password, 4)
  const result = await db.query(
    `INSERT INTO players (email, username, password_hash, is_verified)
     VALUES ($1, $2, $3, TRUE) RETURNING id`,
    [email, username, hash],
  )
  return result.rows[0].id
}

async function loginPlayer(baseUrl, email, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return res.json()
}

async function createTable(baseUrl, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
  })
  return res.json()
}

async function sitAtTable(baseUrl, tableId, seat, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/sit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify({ seat }),
  })
  return res.json()
}

describe('GET /api/player/table', { skip }, () => {
  let server, db, redis

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `pt_player${i}@pttest.spades.invalid`,
        username: `pttest_player${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('returns 401 without auth headers', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/player/table`)
    assert.equal(res.status, 401)
  })

  it('returns { tableId: null } when player is not seated at any table', { timeout: 10000 }, async () => {
    const { sessionId, playerId } = await loginPlayer(
      server.baseUrl,
      'pt_player1@pttest.spades.invalid',
      'password123',
    )
    const res = await fetch(`${server.baseUrl}/api/player/table`, {
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.tableId, null)
  })

  it('returns the tableId when player is seated at a waiting table', { timeout: 10000 }, async () => {
    const { sessionId, playerId } = await loginPlayer(
      server.baseUrl,
      'pt_player1@pttest.spades.invalid',
      'password123',
    )
    const { tableId } = await createTable(server.baseUrl, sessionId, playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', sessionId, playerId)

    const res = await fetch(`${server.baseUrl}/api/player/table`, {
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.tableId, tableId)

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns the tableId when player is seated at a playing table (game not over)', { timeout: 10000 }, async () => {
    // Log in 4 players
    const players = []
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `pt_player${i}@pttest.spades.invalid`,
        'password123',
      )
      players.push(data)
    }

    // Create table and seat all 4 players to start the game
    const { tableId } = await createTable(server.baseUrl, players[0].sessionId, players[0].playerId)
    const seats = ['north', 'east', 'south', 'west']
    for (let i = 0; i < 4; i++) {
      await sitAtTable(server.baseUrl, tableId, seats[i], players[i].sessionId, players[i].playerId)
    }

    // The game is now in 'playing' status and phase should be 'bidding'
    const res = await fetch(`${server.baseUrl}/api/player/table`, {
      headers: { 'x-session-id': players[0].sessionId, 'x-player-id': players[0].playerId },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.tableId, tableId)

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.del(`game:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns { tableId: null } when player is seated at a game_over table', { timeout: 10000 }, async () => {
    // Log in 4 players
    const players = []
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `pt_player${i}@pttest.spades.invalid`,
        'password123',
      )
      players.push(data)
    }

    // Create table and seat all 4 to start game
    const { tableId } = await createTable(server.baseUrl, players[0].sessionId, players[0].playerId)
    const seats = ['north', 'east', 'south', 'west']
    for (let i = 0; i < 4; i++) {
      await sitAtTable(server.baseUrl, tableId, seats[i], players[i].sessionId, players[i].playerId)
    }

    // Manually set game phase to game_over in Redis
    const gameRaw = await redis.get(`game:${tableId}`)
    const gameState = JSON.parse(gameRaw)
    gameState.phase = 'game_over'
    await redis.set(`game:${tableId}`, JSON.stringify(gameState), { EX: 3600 })

    const res = await fetch(`${server.baseUrl}/api/player/table`, {
      headers: { 'x-session-id': players[0].sessionId, 'x-player-id': players[0].playerId },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.tableId, null, 'should not redirect to a game_over table')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.del(`game:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })
})
