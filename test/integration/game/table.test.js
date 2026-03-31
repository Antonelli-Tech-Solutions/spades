/**
 * Integration tests for table creation and seat management.
 * Requires a real Redis instance (REDIS_URL).
 * Tests are skipped when REDIS_URL is not set.
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@gtest.spades.invalid'`)
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

describe('POST /api/tables', { skip }, () => {
  let server, db, redis

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    await insertVerifiedPlayer(db, {
      email: 'host@gtest.spades.invalid',
      username: 'gtest_host',
      password: 'password123',
    })
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('creates a table and returns tableId for authenticated player', async () => {
    const { sessionId, playerId } = await loginPlayer(
      server.baseUrl,
      'host@gtest.spades.invalid',
      'password123',
    )
    const res = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.ok(body.tableId, 'should return a tableId')
  })

  it('returns 401 without auth headers', async () => {
    const res = await fetch(`${server.baseUrl}/api/tables`, { method: 'POST' })
    assert.equal(res.status, 401)
  })
})

describe('POST /api/tables/:tableId/sit', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `sitplayer${i}@gtest.spades.invalid`,
        username: `gtest_sit${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    // Login all 4 players
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `sitplayer${i}@gtest.spades.invalid`,
        'password123',
      )
      players.push(data)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('4 players can sit and game starts automatically', async () => {
    // Host creates table
    const { sessionId, playerId } = players[0]
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    const { tableId } = await createRes.json()

    const seats = ['north', 'east', 'south', 'west']
    for (let i = 0; i < 4; i++) {
      const p = players[i]
      const sitRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': p.sessionId,
          'x-player-id': p.playerId,
        },
        body: JSON.stringify({ seat: seats[i] }),
      })
      assert.equal(sitRes.status, 200, `player ${i + 1} sit failed`)
    }

    // Check game state is now available
    const stateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: { 'x-session-id': players[0].sessionId, 'x-player-id': players[0].playerId },
    })
    assert.equal(stateRes.status, 200)
    const state = await stateRes.json()
    assert.equal(state.phase, 'bidding', 'game should be in bidding phase after all players sit')
    assert.equal(state.myHand.length, 13, 'player should have 13 cards')
  })

  it('returns 409 when seat is already taken', async () => {
    const { sessionId, playerId } = players[0]
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    const { tableId } = await createRes.json()

    // Sit player 0 at north
    await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[0].sessionId,
        'x-player-id': players[0].playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })

    // Try to sit player 1 at north too
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[1].sessionId,
        'x-player-id': players[1].playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })
    assert.equal(res.status, 409)
  })
})

describe('POST /api/tables/:tableId/bid', { skip }, () => {
  let server, db, redis
  const players = []
  let tableId

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `bidplayer${i}@gtest.spades.invalid`,
        username: `gtest_bid${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `bidplayer${i}@gtest.spades.invalid`,
        'password123',
      )
      players.push(data)
    }

    // Set up a table with 4 players
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': players[0].sessionId, 'x-player-id': players[0].playerId },
    })
    const body = await createRes.json()
    tableId = body.tableId

    const seats = ['north', 'east', 'south', 'west']
    for (let i = 0; i < 4; i++) {
      await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': players[i].sessionId,
          'x-player-id': players[i].playerId,
        },
        body: JSON.stringify({ seat: seats[i] }),
      })
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('east player bids first (left of north dealer)', async () => {
    // players[1] is east (second player seated)
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[1].sessionId,
        'x-player-id': players[1].playerId,
      },
      body: JSON.stringify({ bid: 3 }),
    })
    assert.equal(res.status, 200)
    const state = await res.json()
    assert.equal(state.bids.east, 3)
    assert.equal(state.currentBidderSeat, 'south')
  })

  it('returns 409 when wrong player tries to bid', async () => {
    // players[0] is north — but it should be south's turn now
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[0].sessionId,
        'x-player-id': players[0].playerId,
      },
      body: JSON.stringify({ bid: 4 }),
    })
    assert.equal(res.status, 409)
  })

  it('returns 400 for an invalid bid value', async () => {
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[2].sessionId,
        'x-player-id': players[2].playerId,
      },
      body: JSON.stringify({ bid: 14 }),
    })
    assert.equal(res.status, 400)
  })
})
