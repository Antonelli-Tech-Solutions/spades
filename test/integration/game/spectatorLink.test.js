/**
 * Integration tests for shareable spectator links.
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@gspectatorlink.spades.invalid'`)
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

describe('Spectator Link', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)

    const specs = [
      { email: 'host@gspectatorlink.spades.invalid', username: 'sl_host', password: 'password123' },
      { email: 'guest@gspectatorlink.spades.invalid', username: 'sl_guest', password: 'password123' },
      { email: 'other@gspectatorlink.spades.invalid', username: 'sl_other', password: 'password123' },
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

  it('host can generate a spectator link', { timeout: 10000 }, async () => {
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

    const linkRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/spectator-link`, {
      method: 'GET',
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    assert.equal(linkRes.status, 200)
    const body = await linkRes.json()
    assert.ok(body.token, 'should return a token')
    assert.ok(body.spectatorUrl, 'should return a spectatorUrl')
    assert.ok(body.spectatorUrl.includes(body.token), 'spectatorUrl should contain the token')
  })

  it('non-host cannot generate a spectator link', { timeout: 10000 }, async () => {
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

    const linkRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/spectator-link`, {
      method: 'GET',
      headers: { 'x-session-id': guest.sessionId, 'x-player-id': guest.playerId },
    })
    assert.equal(linkRes.status, 403)
  })

  it('valid spectator token grants observe access', { timeout: 10000 }, async () => {
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

    const linkRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/spectator-link`, {
      method: 'GET',
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    const { token } = await linkRes.json()

    const joinRes = await fetch(`${server.baseUrl}/api/tables/spectator-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
    })
    assert.equal(joinRes.status, 200)
    const body = await joinRes.json()
    assert.equal(body.tableId, tableId)
  })

  it('spectator cannot sit at the table', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'public' }),
    })
    const { tableId } = await createRes.json()

    const linkRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/spectator-link`, {
      method: 'GET',
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    const { token } = await linkRes.json()

    await fetch(`${server.baseUrl}/api/tables/spectator-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
    })

    const sitRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
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

  it('expired or invalid spectator token returns 403', { timeout: 10000 }, async () => {
    const guest = players[1]
    const fakeToken = '00000000-0000-0000-0000-000000000000'

    const joinRes = await fetch(`${server.baseUrl}/api/tables/spectator-link/${fakeToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
    })
    assert.equal(joinRes.status, 403)
    const body = await joinRes.json()
    assert.ok(body.error)
  })
})
