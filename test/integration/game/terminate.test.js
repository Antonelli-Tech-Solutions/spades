/**
 * Integration tests for POST /api/tables/:tableId/terminate.
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@term.spades.invalid'`)
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

describe('POST /api/tables/:tableId/terminate', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 2; i++) {
      await insertVerifiedPlayer(db, {
        email: `termplayer${i}@term.spades.invalid`,
        username: `term_player${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 2; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `termplayer${i}@term.spades.invalid`,
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

  it('host can terminate a waiting table', async () => {
    const host = players[0]
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

    // Sit host at a seat so auth check passes on state endpoint
    await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })

    const termRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/terminate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    assert.equal(termRes.status, 200)
    const body = await termRes.json()
    assert.ok(body.message, 'should return a message')

    // Table should no longer be found
    const stateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    assert.equal(stateRes.status, 404, 'table should be gone after termination')
  })

  it('non-host player gets 403', async () => {
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
    const { tableId } = await createRes.json()

    const termRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/terminate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': other.sessionId,
        'x-player-id': other.playerId,
      },
    })
    assert.equal(termRes.status, 403)
  })

  it('returns 404 for unknown tableId', async () => {
    const host = players[0]
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const termRes = await fetch(`${server.baseUrl}/api/tables/${fakeId}/terminate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    assert.equal(termRes.status, 404)
  })

  it('returns 401 without auth headers', async () => {
    const res = await fetch(`${server.baseUrl}/api/tables/some-id/terminate`, {
      method: 'POST',
    })
    assert.equal(res.status, 401)
  })
})
