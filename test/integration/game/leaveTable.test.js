/**
 * Integration tests for POST /api/tables/:tableId/leave.
 * Requires a real Redis instance (REDIS_URL).
 * Tests are skipped when REDIS_URL or DATABASE_URL is not set.
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@leave.spades.invalid'`)
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

describe('POST /api/tables/:tableId/leave', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 3; i++) {
      await insertVerifiedPlayer(db, {
        email: `leaveplayer${i}@leave.spades.invalid`,
        username: `leave_player${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 3; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `leaveplayer${i}@leave.spades.invalid`,
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

  it('seated player can leave a waiting table', async () => {
    const host = players[0]
    const other = players[1]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    assert.equal(createRes.status, 201)
    const { tableId } = await createRes.json()

    // Seat the other player
    await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': other.sessionId,
        'x-player-id': other.playerId,
      },
      body: JSON.stringify({ seat: 'east' }),
    })

    // Other player leaves
    const leaveRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': other.sessionId,
        'x-player-id': other.playerId,
      },
    })
    assert.equal(leaveRes.status, 200)
    const body = await leaveRes.json()
    assert.ok(body.message, 'should return a message')

    // Seat should now be empty
    const stateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: {
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    // Host needs to be seated to check state — seat them first
    await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })
    const stateRes2 = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: {
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    assert.equal(stateRes2.status, 200)
    const stateBody = await stateRes2.json()
    assert.equal(stateBody.seats.east, null, 'east seat should be empty after player left')
  })

  it('returns 409 if player is not seated at the table', async () => {
    const host = players[0]
    const unseated = players[2]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    const { tableId } = await createRes.json()

    const leaveRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': unseated.sessionId,
        'x-player-id': unseated.playerId,
      },
    })
    assert.equal(leaveRes.status, 409)
  })

  it('returns 404 for unknown tableId', async () => {
    const host = players[0]
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const leaveRes = await fetch(`${server.baseUrl}/api/tables/${fakeId}/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    assert.equal(leaveRes.status, 404)
  })

  it('returns 401 without auth headers', async () => {
    const res = await fetch(`${server.baseUrl}/api/tables/some-id/leave`, {
      method: 'POST',
    })
    assert.equal(res.status, 401)
  })

  it('returns 409 if game is in progress', async () => {
    const host = players[0]
    const p2 = players[1]
    const p3 = players[2]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    const { tableId } = await createRes.json()

    // Seat 3 humans + 1 bot to start the game
    const seats = ['north', 'east', 'south']
    const seated = [host, p2, p3]
    for (let i = 0; i < 3; i++) {
      await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': seated[i].sessionId,
          'x-player-id': seated[i].playerId,
        },
        body: JSON.stringify({ seat: seats[i] }),
      })
    }
    // Add a bot to fill the last seat and start the game
    await fetch(`${server.baseUrl}/api/tables/${tableId}/add-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ seat: 'west' }),
    })

    // Game should now be in progress — try to leave
    const leaveRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': p2.sessionId,
        'x-player-id': p2.playerId,
      },
    })
    assert.equal(leaveRes.status, 409)
  })
})
