/**
 * Integration tests for table seating updates:
 *   - Host is auto-seated at north on table creation
 *   - Table is deleted when no players remain
 *   - Host is transferred when host leaves a waiting table
 *   - POST /api/tables/:tableId/change-seat
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@sctest.spades.invalid'`)
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

async function leaveTableApi(baseUrl, tableId, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
  })
  return { status: res.status, body: await res.json() }
}

async function changeSeatApi(baseUrl, tableId, seat, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/change-seat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify({ seat }),
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

async function addBotApi(baseUrl, tableId, seat, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/add-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify({ seat }),
  })
  return { status: res.status, body: await res.json() }
}

async function listTablesApi(baseUrl, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables`, {
    headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
  })
  return { status: res.status, body: await res.json() }
}

describe('Table seating updates', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `sc_player${i}@sctest.spades.invalid`,
        username: `sctest_player${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(server.baseUrl, `sc_player${i}@sctest.spades.invalid`, 'password123')
      players.push(data)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('host is auto-seated at north when creating a table', { timeout: 10000 }, async () => {
    const host = players[0]
    const { status, body } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    assert.equal(status, 201)
    const tableId = body.tableId

    const { status: stateStatus, body: state } = await getStateApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(stateStatus, 200)
    assert.equal(state.status, 'waiting')
    assert.equal(state.seats.north, host.playerId, 'host should be auto-seated at north')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('table is deleted when the last player leaves', { timeout: 10000 }, async () => {
    const host = players[0]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    // Host is now the only player; leave the table
    const { status: leaveStatus } = await leaveTableApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(leaveStatus, 200)

    // Table should no longer exist
    const tableKey = await redis.get(`table:${tableId}`)
    assert.equal(tableKey, null, 'table Redis key should be deleted')
    const lobbyEntry = await redis.hGet('lobby:tables', tableId)
    assert.equal(lobbyEntry, null, 'lobby index entry should be deleted')
  })

  it('host is transferred to next human when host leaves a waiting table', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    // Guest joins at east
    await sitAtTableApi(server.baseUrl, tableId, 'east', guest.sessionId, guest.playerId)

    // Host leaves
    const { status: leaveStatus } = await leaveTableApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(leaveStatus, 200)

    // Guest should now be the host
    const { status: stateStatus, body: state } = await getStateApi(server.baseUrl, tableId, guest.sessionId, guest.playerId)
    assert.equal(stateStatus, 200)
    assert.equal(state.isHost, true, 'guest should now be the host')
    assert.equal(state.seats.north, null, 'north seat should be empty after host left')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('seated player can change to an empty seat', { timeout: 10000 }, async () => {
    const host = players[0]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    // Host is at north — change to east
    const { status, body } = await changeSeatApi(server.baseUrl, tableId, 'east', host.sessionId, host.playerId)
    assert.equal(status, 200)
    assert.equal(body.seat, 'east')

    const { body: state } = await getStateApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(state.seats.north, null, 'north should be empty after moving')
    assert.equal(state.seats.east, host.playerId, 'host should now be at east')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('change-seat returns 409 when target seat is taken', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    // Guest sits at east
    await sitAtTableApi(server.baseUrl, tableId, 'east', guest.sessionId, guest.playerId)

    // Host tries to move to east (taken)
    const { status } = await changeSeatApi(server.baseUrl, tableId, 'east', host.sessionId, host.playerId)
    assert.equal(status, 409)

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('change-seat returns 409 when player is not seated', { timeout: 10000 }, async () => {
    const host = players[0]
    const unseated = players[2]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    const { status } = await changeSeatApi(server.baseUrl, tableId, 'east', unseated.sessionId, unseated.playerId)
    assert.equal(status, 409)

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('change-seat returns 400 for invalid seat name', { timeout: 10000 }, async () => {
    const host = players[0]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    const { status } = await changeSeatApi(server.baseUrl, tableId, 'invalid', host.sessionId, host.playerId)
    assert.equal(status, 400)

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('change-seat returns 401 without auth', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/tables/fake-id/change-seat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat: 'east' }),
    })
    assert.equal(res.status, 401)
  })

  it('change-seat with same seat is a no-op and returns 200 with unchanged seat', { timeout: 10000 }, async () => {
    const host = players[0]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    // Host is at north — change to north again (same seat)
    const { status, body } = await changeSeatApi(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)
    assert.equal(status, 200)
    assert.equal(body.seat, 'north')

    const { body: state } = await getStateApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(state.seats.north.playerId, host.playerId, 'host should still be at north')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('GET /api/tables/:tableId/state returns enriched seat data with username and isBot', { timeout: 10000 }, async () => {
    const host = players[0]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    const { status, body: state } = await getStateApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(status, 200)
    assert.equal(state.status, 'waiting')

    // North seat should be enriched with host's username
    const northSeat = state.seats.north
    assert.ok(northSeat !== null, 'north seat should be occupied')
    assert.equal(northSeat.playerId, host.playerId, 'seat should have playerId')
    assert.equal(northSeat.username, 'sctest_player1', 'seat should have username')
    assert.equal(northSeat.isBot, false, 'seat should not be a bot')

    // Empty seats should remain null
    assert.equal(state.seats.east, null)
    assert.equal(state.seats.south, null)
    assert.equal(state.seats.west, null)

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('bot seats in /state have isBot true and username Bot', { timeout: 10000 }, async () => {
    const host = players[0]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    await addBotApi(server.baseUrl, tableId, 'east', host.sessionId, host.playerId)

    const { body: state } = await getStateApi(server.baseUrl, tableId, host.sessionId, host.playerId)

    const eastSeat = state.seats.east
    assert.ok(eastSeat !== null, 'east seat should be occupied by bot')
    assert.equal(eastSeat.playerId, 'bot:east')
    assert.equal(eastSeat.username, 'Bot')
    assert.equal(eastSeat.isBot, true)

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('GET /api/tables returns enriched seat data with username and isBot', { timeout: 10000 }, async () => {
    const host = players[0]
    const { body: createBody } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const tableId = createBody.tableId

    const { status, body } = await listTablesApi(server.baseUrl, host.sessionId, host.playerId)
    assert.equal(status, 200)

    const table = body.tables.find((t) => t.tableId === tableId)
    assert.ok(table, 'table should be in the list')

    const northSeat = table.seats.north
    assert.ok(northSeat !== null)
    assert.equal(northSeat.playerId, host.playerId)
    assert.equal(northSeat.username, 'sctest_player1')
    assert.equal(northSeat.isBot, false)

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })
})
