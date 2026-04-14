/**
 * Integration tests for host controls:
 *   POST /api/tables/:tableId/assign-seat
 *   POST /api/tables/:tableId/kick
 *   POST /api/tables/:tableId/transfer-host
 *
 * Requires real Redis and database instances.
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@hostctl.spades.invalid'`)
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

function authHeaders(player) {
  return {
    'Content-Type': 'application/json',
    'x-session-id': player.sessionId,
    'x-player-id': player.playerId,
  }
}

async function createTableApi(baseUrl, player) {
  const res = await fetch(`${baseUrl}/api/tables`, {
    method: 'POST',
    headers: authHeaders(player),
  })
  return { status: res.status, body: await res.json() }
}

async function sitPlayer(baseUrl, tableId, seat, player) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/sit`, {
    method: 'POST',
    headers: authHeaders(player),
    body: JSON.stringify({ seat }),
  })
  return { status: res.status, body: await res.json() }
}

async function getState(baseUrl, tableId, player) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/state`, {
    headers: authHeaders(player),
  })
  return { status: res.status, body: await res.json() }
}

describe('Host controls', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `hcplayer${i}@hostctl.spades.invalid`,
        username: `hc_player${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(server.baseUrl, `hcplayer${i}@hostctl.spades.invalid`, 'password123')
      players.push(data)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  // ── assign-seat ─────────────────────────────────────────────────────────

  describe('POST /api/tables/:tableId/assign-seat', () => {
    it('host can assign a seated player to a different seat', { timeout: 10000 }, async () => {
      const host = players[0]
      const other = players[1]
      const { body: { tableId } } = await createTableApi(server.baseUrl, host)
      await sitPlayer(server.baseUrl, tableId, 'north', host)
      await sitPlayer(server.baseUrl, tableId, 'east', other)

      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
        method: 'POST',
        headers: authHeaders(host),
        body: JSON.stringify({ playerId: other.playerId, seat: 'south' }),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.seat, 'south')

      const { body: state } = await getState(server.baseUrl, tableId, host)
      assert.equal(state.seats.east?.playerId ?? state.seats.east, null)
      const southId = state.seats.south?.playerId ?? state.seats.south
      assert.equal(southId, other.playerId)

      await redis.del(`table:${tableId}`)
      await redis.hDel('lobby:tables', tableId)
    })

    it('non-host gets 403', { timeout: 10000 }, async () => {
      const host = players[0]
      const other = players[1]
      const { body: { tableId } } = await createTableApi(server.baseUrl, host)
      await sitPlayer(server.baseUrl, tableId, 'north', host)
      await sitPlayer(server.baseUrl, tableId, 'east', other)

      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
        method: 'POST',
        headers: authHeaders(other),
        body: JSON.stringify({ playerId: host.playerId, seat: 'south' }),
      })
      assert.equal(res.status, 403)

      await redis.del(`table:${tableId}`)
      await redis.hDel('lobby:tables', tableId)
    })

    it('returns 409 when target seat is taken', { timeout: 10000 }, async () => {
      const host = players[0]
      const p2 = players[1]
      const p3 = players[2]
      const { body: { tableId } } = await createTableApi(server.baseUrl, host)
      await sitPlayer(server.baseUrl, tableId, 'north', host)
      await sitPlayer(server.baseUrl, tableId, 'east', p2)
      await sitPlayer(server.baseUrl, tableId, 'south', p3)

      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
        method: 'POST',
        headers: authHeaders(host),
        body: JSON.stringify({ playerId: p2.playerId, seat: 'south' }),
      })
      assert.equal(res.status, 409)

      await redis.del(`table:${tableId}`)
      await redis.hDel('lobby:tables', tableId)
    })

    it('returns 400 for invalid seat', { timeout: 10000 }, async () => {
      const host = players[0]
      const { body: { tableId } } = await createTableApi(server.baseUrl, host)
      await sitPlayer(server.baseUrl, tableId, 'north', host)

      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
        method: 'POST',
        headers: authHeaders(host),
        body: JSON.stringify({ playerId: players[1].playerId, seat: 'center' }),
      })
      assert.equal(res.status, 400)

      await redis.del(`table:${tableId}`)
      await redis.hDel('lobby:tables', tableId)
    })

    it('returns 401 without auth', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/tables/fake-id/assign-seat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: 'x', seat: 'north' }),
      })
      assert.equal(res.status, 401)
    })
  })

  // ── kick ─────────────────────────────────────────────────────────────────

  describe('POST /api/tables/:tableId/kick', () => {
    it('host can kick a seated player', { timeout: 10000 }, async () => {
      const host = players[0]
      const other = players[1]
      const { body: { tableId } } = await createTableApi(server.baseUrl, host)
      await sitPlayer(server.baseUrl, tableId, 'north', host)
      await sitPlayer(server.baseUrl, tableId, 'east', other)

      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
        method: 'POST',
        headers: authHeaders(host),
        body: JSON.stringify({ playerId: other.playerId }),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.kickedPlayerId, other.playerId)
      assert.equal(body.seat, 'east')

      const { body: state } = await getState(server.baseUrl, tableId, host)
      const eastId = state.seats.east?.playerId ?? state.seats.east
      assert.equal(eastId, null)

      await redis.del(`table:${tableId}`)
      await redis.hDel('lobby:tables', tableId)
    })

    it('non-host gets 403', { timeout: 10000 }, async () => {
      const host = players[0]
      const other = players[1]
      const { body: { tableId } } = await createTableApi(server.baseUrl, host)
      await sitPlayer(server.baseUrl, tableId, 'north', host)
      await sitPlayer(server.baseUrl, tableId, 'east', other)

      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
        method: 'POST',
        headers: authHeaders(other),
        body: JSON.stringify({ playerId: host.playerId }),
      })
      assert.equal(res.status, 403)

      await redis.del(`table:${tableId}`)
      await redis.hDel('lobby:tables', tableId)
    })

    it('host cannot kick themselves', { timeout: 10000 }, async () => {
      const host = players[0]
      const { body: { tableId } } = await createTableApi(server.baseUrl, host)
      await sitPlayer(server.baseUrl, tableId, 'north', host)

      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
        method: 'POST',
        headers: authHeaders(host),
        body: JSON.stringify({ playerId: host.playerId }),
      })
      assert.equal(res.status, 409)

      await redis.del(`table:${tableId}`)
      await redis.hDel('lobby:tables', tableId)
    })

    it('returns 404 for unknown table', { timeout: 10000 }, async () => {
      const host = players[0]
      const fakeId = '00000000-0000-0000-0000-000000000000'
      const res = await fetch(`${server.baseUrl}/api/tables/${fakeId}/kick`, {
        method: 'POST',
        headers: authHeaders(host),
        body: JSON.stringify({ playerId: players[1].playerId }),
      })
      assert.equal(res.status, 404)
    })

    it('returns 401 without auth', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/tables/fake-id/kick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: 'x' }),
      })
      assert.equal(res.status, 401)
    })
  })

  // ── transfer-host ────────────────────────────────────────────────────────

  describe('POST /api/tables/:tableId/transfer-host', () => {
    it('host can transfer host to another seated player', { timeout: 10000 }, async () => {
      const host = players[0]
      const other = players[1]
      const { body: { tableId } } = await createTableApi(server.baseUrl, host)
      await sitPlayer(server.baseUrl, tableId, 'north', host)
      await sitPlayer(server.baseUrl, tableId, 'east', other)

      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
        method: 'POST',
        headers: authHeaders(host),
        body: JSON.stringify({ playerId: other.playerId }),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.newHostPlayerId, other.playerId)

      const { body: state } = await getState(server.baseUrl, tableId, other)
      assert.equal(state.isHost, true)

      const { body: state2 } = await getState(server.baseUrl, tableId, host)
      assert.equal(state2.isHost, false)

      await redis.del(`table:${tableId}`)
      await redis.hDel('lobby:tables', tableId)
    })

    it('non-host gets 403', { timeout: 10000 }, async () => {
      const host = players[0]
      const other = players[1]
      const p3 = players[2]
      const { body: { tableId } } = await createTableApi(server.baseUrl, host)
      await sitPlayer(server.baseUrl, tableId, 'north', host)
      await sitPlayer(server.baseUrl, tableId, 'east', other)
      await sitPlayer(server.baseUrl, tableId, 'south', p3)

      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
        method: 'POST',
        headers: authHeaders(other),
        body: JSON.stringify({ playerId: p3.playerId }),
      })
      assert.equal(res.status, 403)

      await redis.del(`table:${tableId}`)
      await redis.hDel('lobby:tables', tableId)
    })

    it('returns 409 when target is not seated', { timeout: 10000 }, async () => {
      const host = players[0]
      const other = players[1]
      const { body: { tableId } } = await createTableApi(server.baseUrl, host)
      await sitPlayer(server.baseUrl, tableId, 'north', host)

      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
        method: 'POST',
        headers: authHeaders(host),
        body: JSON.stringify({ playerId: other.playerId }),
      })
      assert.equal(res.status, 409)

      await redis.del(`table:${tableId}`)
      await redis.hDel('lobby:tables', tableId)
    })

    it('returns 404 for unknown table', { timeout: 10000 }, async () => {
      const host = players[0]
      const fakeId = '00000000-0000-0000-0000-000000000000'
      const res = await fetch(`${server.baseUrl}/api/tables/${fakeId}/transfer-host`, {
        method: 'POST',
        headers: authHeaders(host),
        body: JSON.stringify({ playerId: players[1].playerId }),
      })
      assert.equal(res.status, 404)
    })

    it('returns 401 without auth', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/tables/fake-id/transfer-host`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: 'x' }),
      })
      assert.equal(res.status, 401)
    })
  })
})
