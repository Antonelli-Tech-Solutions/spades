/**
 * Integration tests for spectating access control (Issue #605).
 * Verifies that players arriving at a table are placed in observer state
 * when spectating is enabled, and rejected when spectating is disabled
 * (unless they have a join or spectator link).
 *
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@gspectatingaccess.spades.invalid'`)
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

describe('Spectating Access Control', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)

    const specs = [
      { email: 'host@gspectatingaccess.spades.invalid', username: 'sa_host', password: 'password123' },
      { email: 'guest@gspectatingaccess.spades.invalid', username: 'sa_guest', password: 'password123' },
      { email: 'other@gspectatingaccess.spades.invalid', username: 'sa_other', password: 'password123' },
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

  it('player arriving at a public table with spectating enabled is placed in observer state', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ name: 'Spectating Enabled', spectating: true }),
    })
    assert.equal(createRes.status, 201)
    const { tableId } = await createRes.json()

    const joinRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
    })
    assert.equal(joinRes.status, 200)
    const joinBody = await joinRes.json()
    assert.equal(joinBody.tableId, tableId)

    const stateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: {
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
    })
    assert.equal(stateRes.status, 200)
    const state = await stateRes.json()
    assert.equal(state.status, 'spectating')
  })

  it('player arriving at a table with spectating disabled is rejected with 403', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ name: 'Spectating Disabled', spectating: false }),
    })
    assert.equal(createRes.status, 201)
    const { tableId } = await createRes.json()

    const joinRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/join`, {
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

  it('player with a join link can arrive at a table with spectating disabled', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ name: 'Join Link Override', spectating: false }),
    })
    assert.equal(createRes.status, 201)
    const { tableId } = await createRes.json()

    const linkRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/join-link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    assert.equal(linkRes.status, 200)
    const { token } = await linkRes.json()

    const useRes = await fetch(`${server.baseUrl}/api/tables/join-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
      body: JSON.stringify({ seat: 'south' }),
    })
    assert.equal(useRes.status, 200)
    const useBody = await useRes.json()
    assert.equal(useBody.tableId, tableId)
    assert.equal(useBody.seat, 'south')
  })

  it('player with a spectator link can arrive at a table even though they use asSpectator flow', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ name: 'Spectator Link Table', spectating: true }),
    })
    assert.equal(createRes.status, 201)
    const { tableId } = await createRes.json()

    const linkRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/spectator-link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    assert.equal(linkRes.status, 200)
    const { token } = await linkRes.json()

    const useRes = await fetch(`${server.baseUrl}/api/tables/spectator-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
    })
    assert.equal(useRes.status, 200)

    const stateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: {
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
    })
    assert.equal(stateRes.status, 200)
    const state = await stateRes.json()
    assert.equal(state.status, 'spectating')
  })

  it('lobby table listing includes observerCount', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]
    const other = players[2]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ name: 'Observer Count Table', spectating: true }),
    })
    assert.equal(createRes.status, 201)
    const { tableId } = await createRes.json()

    await fetch(`${server.baseUrl}/api/tables/${tableId}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
    })

    await fetch(`${server.baseUrl}/api/tables/${tableId}/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': other.sessionId,
        'x-player-id': other.playerId,
      },
    })

    const listRes = await fetch(`${server.baseUrl}/api/tables`, {
      headers: {
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    assert.equal(listRes.status, 200)
    const { tables } = await listRes.json()
    const table = tables.find((t) => t.tableId === tableId)
    assert.ok(table, 'Table should appear in lobby listing')
    assert.equal(table.observerCount, 2)
  })

  it('lobby table listing includes spectating field', { timeout: 10000 }, async () => {
    const host = players[0]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ name: 'Spectating Field Table', spectating: false }),
    })
    assert.equal(createRes.status, 201)
    const { tableId } = await createRes.json()

    const listRes = await fetch(`${server.baseUrl}/api/tables`, {
      headers: {
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    assert.equal(listRes.status, 200)
    const { tables } = await listRes.json()
    const table = tables.find((t) => t.tableId === tableId)
    assert.ok(table, 'Table should appear in lobby listing')
    assert.equal(table.spectating, false)
    assert.equal(table.observerCount, 0)
  })
})
