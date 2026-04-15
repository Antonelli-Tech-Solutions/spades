/**
 * Integration tests for POST /api/tables/:tableId/assign-seat
 *
 * The host can move a seated player to a different seat during the waiting phase.
 *
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
import { markTablePlaying } from '../../../server/lobby/table.js'

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
  await db.query(`DELETE FROM players WHERE email LIKE '%@astest.spades.invalid'`)
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

async function createTableApi(baseUrl, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
  })
  return { status: res.status, body: await res.json() }
}

async function getStateApi(baseUrl, tableId, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/state`, {
    headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
  })
  return { status: res.status, body: await res.json() }
}

async function sitAtTableApi(baseUrl, tableId, seat, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/sit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify({ seat }),
  })
  return { status: res.status, body: await res.json() }
}

async function assignSeatApi(baseUrl, tableId, targetPlayerId, seat, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/assign-seat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify({ playerId: targetPlayerId, seat }),
  })
  return { status: res.status, body: await res.json() }
}

describe('POST /api/tables/:tableId/assign-seat', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `as_player${i}@astest.spades.invalid`,
        username: `astest_player${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(server.baseUrl, `as_player${i}@astest.spades.invalid`, 'password123')
      players.push(data)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('host can move a seated player to an empty seat', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    await sitAtTableApi(server.baseUrl, tableId, 'east', guest.sessionId, guest.playerId)

    const { status, body } = await assignSeatApi(
      server.baseUrl, tableId, guest.playerId, 'south', host.sessionId, host.playerId,
    )
    assert.equal(status, 200)

    const { body: state } = await getStateApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(state.seats.east, null, 'east should be empty after move')
    assert.equal(state.seats.south.playerId ?? state.seats.south, guest.playerId, 'guest should now be at south')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('host can move themselves to an empty seat', { timeout: 10000 }, async () => {
    const host = players[0]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    const { status } = await assignSeatApi(
      server.baseUrl, tableId, host.playerId, 'west', host.sessionId, host.playerId,
    )
    assert.equal(status, 200)

    const { body: state } = await getStateApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(state.seats.north, null, 'north should be empty after host moved')
    assert.equal(state.seats.west.playerId ?? state.seats.west, host.playerId, 'host should now be at west')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('non-host gets 403 when trying to assign seats', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    await sitAtTableApi(server.baseUrl, tableId, 'east', guest.sessionId, guest.playerId)

    const { status } = await assignSeatApi(
      server.baseUrl, tableId, host.playerId, 'south', guest.sessionId, guest.playerId,
    )
    assert.equal(status, 403)

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns 409 when table is in playing status', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    await sitAtTableApi(server.baseUrl, tableId, 'east', guest.sessionId, guest.playerId)
    await markTablePlaying(redis, tableId, 'test-game-id')

    const { status } = await assignSeatApi(
      server.baseUrl, tableId, guest.playerId, 'south', host.sessionId, host.playerId,
    )
    assert.equal(status, 409)

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns 409 when target seat is already occupied', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest1 = players[1]
    const guest2 = players[2]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    await sitAtTableApi(server.baseUrl, tableId, 'east', guest1.sessionId, guest1.playerId)
    await sitAtTableApi(server.baseUrl, tableId, 'south', guest2.sessionId, guest2.playerId)

    const { status } = await assignSeatApi(
      server.baseUrl, tableId, guest1.playerId, 'south', host.sessionId, host.playerId,
    )
    assert.equal(status, 409)

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns error when target player is not seated at the table', { timeout: 10000 }, async () => {
    const host = players[0]
    const unseated = players[2]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    const { status } = await assignSeatApi(
      server.baseUrl, tableId, unseated.playerId, 'east', host.sessionId, host.playerId,
    )
    assert.ok([400, 409].includes(status), `expected 400 or 409, got ${status}`)

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns 400 for invalid seat name', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    await sitAtTableApi(server.baseUrl, tableId, 'east', guest.sessionId, guest.playerId)

    const { status } = await assignSeatApi(
      server.baseUrl, tableId, guest.playerId, 'northwest', host.sessionId, host.playerId,
    )
    assert.equal(status, 400)

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns 401 without auth headers', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/tables/fake-id/assign-seat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'some-id', seat: 'east' }),
    })
    assert.equal(res.status, 401)
  })

  it('returns 404 for a non-existent table', { timeout: 10000 }, async () => {
    const host = players[0]

    const { status } = await assignSeatApi(
      server.baseUrl, 'nonexistent-table-id', host.playerId, 'east', host.sessionId, host.playerId,
    )
    assert.equal(status, 404)
  })

  it('assigning player to their current seat is a no-op', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    await sitAtTableApi(server.baseUrl, tableId, 'east', guest.sessionId, guest.playerId)

    const { status } = await assignSeatApi(
      server.baseUrl, tableId, guest.playerId, 'east', host.sessionId, host.playerId,
    )
    assert.equal(status, 200)

    const { body: state } = await getStateApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(state.seats.east.playerId ?? state.seats.east, guest.playerId, 'guest should still be at east')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('seat state is correct after multiple assign-seat operations', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest1 = players[1]
    const guest2 = players[2]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    await sitAtTableApi(server.baseUrl, tableId, 'east', guest1.sessionId, guest1.playerId)
    await sitAtTableApi(server.baseUrl, tableId, 'south', guest2.sessionId, guest2.playerId)

    // Move guest1 from east to west
    const { status: s1 } = await assignSeatApi(
      server.baseUrl, tableId, guest1.playerId, 'west', host.sessionId, host.playerId,
    )
    assert.equal(s1, 200)

    // Move guest2 from south to east (now empty)
    const { status: s2 } = await assignSeatApi(
      server.baseUrl, tableId, guest2.playerId, 'east', host.sessionId, host.playerId,
    )
    assert.equal(s2, 200)

    const { body: state } = await getStateApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(state.seats.north.playerId ?? state.seats.north, host.playerId, 'host at north')
    assert.equal(state.seats.east.playerId ?? state.seats.east, guest2.playerId, 'guest2 at east')
    assert.equal(state.seats.south, null, 'south should be empty')
    assert.equal(state.seats.west.playerId ?? state.seats.west, guest1.playerId, 'guest1 at west')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('request body requires both playerId and seat fields', { timeout: 10000 }, async () => {
    const host = players[0]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    // Missing seat
    const res1 = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
      body: JSON.stringify({ playerId: host.playerId }),
    })
    assert.ok([400, 409].includes(res1.status), `missing seat should fail, got ${res1.status}`)

    // Missing playerId
    const res2 = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
      body: JSON.stringify({ seat: 'east' }),
    })
    assert.ok([400, 409].includes(res2.status), `missing playerId should fail, got ${res2.status}`)

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })
})
