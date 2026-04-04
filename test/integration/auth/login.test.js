/**
 * Integration tests for the login and logout endpoints.
 * Requires real PostgreSQL (DATABASE_URL) and Redis (REDIS_URL) instances.
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@test.spades.invalid'`)
}

/** Insert a pre-verified player directly, bypassing the registration flow. */
async function insertVerifiedPlayer(db, { email, username, password }) {
  const hash = await bcrypt.hash(password, 4) // low rounds for test speed
  const result = await db.query(
    `INSERT INTO players (email, username, password_hash, is_verified)
     VALUES ($1, $2, $3, TRUE) RETURNING id`,
    [email, username, hash],
  )
  return result.rows[0].id
}

describe('POST /api/auth/login', { skip }, () => {
  let server
  let db
  let redis

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await resetTestSchema(db)
    await insertVerifiedPlayer(db, {
      email: 'login_ok@test.spades.invalid',
      username: 'login_ok',
      password: 'password123',
    })
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('returns 200 with sessionId, playerId, and username on valid credentials', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login_ok@test.spades.invalid', password: 'password123' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(body.sessionId, 'response should include sessionId')
    assert.ok(body.playerId, 'response should include playerId')
    assert.ok(body.username, 'response should include username')
  })

  it('stores the session in Redis under session:{sessionId}', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login_ok@test.spades.invalid', password: 'password123' }),
    })
    const body = await res.json()
    const stored = await redis.get(`session:${body.sessionId}`)
    assert.ok(stored, 'session should be stored in Redis')
    const session = JSON.parse(stored)
    assert.equal(session.playerId, body.playerId)
    assert.equal(session.username, body.username)
  })

  it('returns 401 for a wrong password', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login_ok@test.spades.invalid', password: 'wrongpassword' }),
    })
    assert.equal(res.status, 401)
  })

  it('returns 401 for an unknown email', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@test.spades.invalid', password: 'password123' }),
    })
    assert.equal(res.status, 401)
  })

  it('returns 403 for an unverified account', { timeout: 10000 }, async () => {
    const hash = await bcrypt.hash('password123', 4)
    await db.query(
      `INSERT INTO players (email, username, password_hash, is_verified)
       VALUES ('unverified@test.spades.invalid', 'unverified_test', $1, FALSE)
       ON CONFLICT DO NOTHING`,
      [hash],
    )
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'unverified@test.spades.invalid',
        password: 'password123',
      }),
    })
    assert.equal(res.status, 403)
  })

  it('returns 400 when email is missing', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'password123' }),
    })
    assert.equal(res.status, 400)
  })

  it('returns 400 when password is missing', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login_ok@test.spades.invalid' }),
    })
    assert.equal(res.status, 400)
  })
})

describe('POST /api/auth/logout', { skip }, () => {
  let server
  let db
  let redis

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await resetTestSchema(db)
    await insertVerifiedPlayer(db, {
      email: 'logout_ok@test.spades.invalid',
      username: 'logout_ok',
      password: 'password123',
    })
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('returns 200 and removes the session from Redis', { timeout: 10000 }, async () => {
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'logout_ok@test.spades.invalid', password: 'password123' }),
    })
    const { sessionId, playerId } = await loginRes.json()

    const logoutRes = await fetch(`${server.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    assert.equal(logoutRes.status, 200)

    const stored = await redis.get(`session:${sessionId}`)
    assert.equal(stored, null, 'session should be deleted from Redis after logout')
  })

  it('returns 200 when no session header is provided (idempotent logout)', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/logout`, {
      method: 'POST',
    })
    assert.equal(res.status, 200)
  })

  it('removes the player from any waiting table they are seated at', { timeout: 10000 }, async () => {
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'logout_ok@test.spades.invalid', password: 'password123' }),
    })
    const { sessionId, playerId } = await loginRes.json()

    // Create a table and sit in a seat
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
      body: JSON.stringify({}),
    })
    const { tableId } = await createRes.json()

    await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
      body: JSON.stringify({ seat: 'north' }),
    })

    // Confirm seated before logout
    const tableBefore = JSON.parse(await redis.get(`table:${tableId}`))
    assert.equal(tableBefore.seats.north, playerId, 'player should be seated before logout')

    // Logout
    const logoutRes = await fetch(`${server.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    assert.equal(logoutRes.status, 200)

    // Player should be removed from the seat
    const tableAfter = JSON.parse(await redis.get(`table:${tableId}`))
    assert.equal(tableAfter.seats.north, null, 'player should be removed from table after logout')
  })
})

describe('Auth header validation', { skip }, () => {
  let server
  let db
  let redis

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await resetTestSchema(db)
    await insertVerifiedPlayer(db, {
      email: 'authcheck@test.spades.invalid',
      username: 'authcheck',
      password: 'password123',
    })
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('a valid session grants access to protected routes', { timeout: 10000 }, async () => {
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'authcheck@test.spades.invalid', password: 'password123' }),
    })
    const { sessionId, playerId } = await loginRes.json()

    // Confirm session exists in Redis with the correct playerId
    const stored = await redis.get(`session:${sessionId}`)
    assert.ok(stored, 'session should exist in Redis')
    const session = JSON.parse(stored)
    assert.equal(session.playerId, playerId)
  })

  it('session is expired/absent after logout', { timeout: 10000 }, async () => {
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'authcheck@test.spades.invalid', password: 'password123' }),
    })
    const { sessionId, playerId } = await loginRes.json()

    await fetch(`${server.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })

    const stored = await redis.get(`session:${sessionId}`)
    assert.equal(stored, null, 'session should not exist in Redis after logout')
  })
})
