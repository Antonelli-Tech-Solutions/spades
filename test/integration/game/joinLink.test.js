/**
 * Integration tests for shareable join links.
 * Requires a real Redis instance (REDIS_URL) and database (DATABASE_URL).
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@gjoinlink.spades.invalid'`)
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

describe('Join Link', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)

    const specs = [
      { email: 'host@gjoinlink.spades.invalid', username: 'jl_host', password: 'password123' },
      { email: 'guest@gjoinlink.spades.invalid', username: 'jl_guest', password: 'password123' },
      { email: 'other@gjoinlink.spades.invalid', username: 'jl_other', password: 'password123' },
    ]
    for (const spec of specs) {
      await insertVerifiedPlayer(db, spec)
    }
    server = await startTestServer()
    for (const spec of specs) {
      const session = await loginPlayer(server.baseUrl, spec.email, spec.password)
      players.push(session)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('host can generate a join link', { timeout: 10000 }, async () => {
    const host = players[0]
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'private' }),
    })
    assert.equal(createRes.status, 201)
    const { tableId } = await createRes.json()

    const linkRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/join-link`, {
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    assert.equal(linkRes.status, 200)
    const body = await linkRes.json()
    assert.ok(body.token, 'should return a token')
    assert.ok(body.joinUrl, 'should return a joinUrl')
    assert.ok(body.joinUrl.includes(body.token), 'joinUrl should contain the token')
  })

  it('non-host cannot generate a join link', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'private' }),
    })
    const { tableId } = await createRes.json()

    const linkRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/join-link`, {
      headers: { 'x-session-id': guest.sessionId, 'x-player-id': guest.playerId },
    })
    assert.equal(linkRes.status, 403)
  })

  it('valid token grants seating at a private invite-only table', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'private' }),
    })
    const { tableId } = await createRes.json()

    const linkRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/join-link`, {
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    const { token } = await linkRes.json()

    const sitRes = await fetch(`${server.baseUrl}/api/tables/join-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
      body: JSON.stringify({ seat: 'east' }),
    })
    assert.equal(sitRes.status, 200)
    const body = await sitRes.json()
    assert.equal(body.tableId, tableId)
    assert.equal(body.seat, 'east')
  })

  it('expired or invalid token returns 403', { timeout: 10000 }, async () => {
    const guest = players[1]
    const fakeToken = '00000000-0000-0000-0000-000000000000'

    const sitRes = await fetch(`${server.baseUrl}/api/tables/join-link/${fakeToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
      body: JSON.stringify({ seat: 'east' }),
    })
    assert.equal(sitRes.status, 403)
    const body = await sitRes.json()
    assert.ok(body.error)
  })

  it('join link for deleted table returns 404', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'private' }),
    })
    const { tableId } = await createRes.json()

    const linkRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/join-link`, {
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    const { token } = await linkRes.json()

    // Terminate the table
    await fetch(`${server.baseUrl}/api/tables/${tableId}/terminate`, {
      method: 'POST',
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })

    const sitRes = await fetch(`${server.baseUrl}/api/tables/join-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
      body: JSON.stringify({ seat: 'east' }),
    })
    assert.equal(sitRes.status, 404)
  })
})
