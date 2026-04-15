/**
 * Integration tests for POST /api/tables/:tableId/transfer-host
 *
 * Covers: successful transfer, non-host gets 403, transfer to non-seated
 * player fails, transfer to bot fails, transfer during active game works.
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@thtest.spades.invalid'`)
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
  return res.json()
}

async function sitAtTable(baseUrl, tableId, seat, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/sit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify({ seat }),
  })
  return res.json()
}

async function addBot(baseUrl, tableId, seat, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/add-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify({ seat }),
  })
  return res.json()
}

async function transferHost(baseUrl, tableId, targetPlayerId, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/transfer-host`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify({ playerId: targetPlayerId }),
  })
  return { status: res.status, body: await res.json() }
}

async function getGameStateApi(baseUrl, tableId, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/state`, {
    headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
  })
  return res.json()
}

describe('POST /api/tables/:tableId/transfer-host', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `th_player${i}@thtest.spades.invalid`,
        username: `thtest_player${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(server.baseUrl, `th_player${i}@thtest.spades.invalid`, 'password123')
      players.push(data)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('successfully transfers host to another seated human player', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const { tableId } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'south', guest.sessionId, guest.playerId)

    const { status, body } = await transferHost(server.baseUrl, tableId, guest.playerId, host.sessionId, host.playerId)

    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`)
    assert.equal(body.hostPlayerId, guest.playerId, 'New host should be the target player')

    const state = await getGameStateApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(state.hostSeat, 'south', 'hostSeat should reflect the new host seat')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns 403 when a non-host tries to transfer host', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const { tableId } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'south', guest.sessionId, guest.playerId)

    const { status, body } = await transferHost(server.baseUrl, tableId, host.playerId, guest.sessionId, guest.playerId)

    assert.equal(status, 403, `Expected 403 but got ${status}: ${JSON.stringify(body)}`)
    assert.ok(body.error, 'Response should include an error message')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('fails when target player is not seated at the table', { timeout: 10000 }, async () => {
    const host = players[0]
    const unseatedPlayer = players[2]

    const { tableId } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)

    const { status, body } = await transferHost(server.baseUrl, tableId, unseatedPlayer.playerId, host.sessionId, host.playerId)

    assert.ok(status >= 400, `Expected an error status but got ${status}: ${JSON.stringify(body)}`)
    assert.ok(body.error, 'Response should include an error message')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('fails when target is a bot', { timeout: 10000 }, async () => {
    const host = players[0]

    const { tableId } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)
    await addBot(server.baseUrl, tableId, 'east', host.sessionId, host.playerId)

    const table = JSON.parse(await redis.get(`table:${tableId}`))
    const botId = table.seats.east

    const { status, body } = await transferHost(server.baseUrl, tableId, botId, host.sessionId, host.playerId)

    assert.ok(status >= 400, `Expected an error status but got ${status}: ${JSON.stringify(body)}`)
    assert.ok(body.error, 'Response should include an error message')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('successfully transfers host during an active game', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[1]

    const { tableId } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    const seats = ['north', 'east', 'south', 'west']
    for (let i = 0; i < 4; i++) {
      await sitAtTable(server.baseUrl, tableId, seats[i], players[i].sessionId, players[i].playerId)
    }

    const preState = await getGameStateApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(preState.status, 'playing', 'Game should be in progress')

    const { status, body } = await transferHost(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId)

    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`)
    assert.equal(body.hostPlayerId, target.playerId, 'New host should be the target player during active game')

    const postState = await getGameStateApi(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(postState.status, 'playing', 'Game should still be in progress after host transfer')
    assert.equal(postState.hostSeat, 'east', 'hostSeat should reflect new host at east')

    await redis.del(`table:${tableId}`)
    await redis.del(`game:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns 401 when session is missing', { timeout: 10000 }, async () => {
    const host = players[0]
    const { tableId } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: host.playerId }),
    })

    assert.equal(res.status, 401, 'Missing session should return 401')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns 404 when table does not exist', { timeout: 10000 }, async () => {
    const host = players[0]
    const fakeTableId = '00000000-0000-0000-0000-000000000000'

    const { status, body } = await transferHost(server.baseUrl, fakeTableId, players[1].playerId, host.sessionId, host.playerId)

    assert.equal(status, 404, `Expected 404 but got ${status}: ${JSON.stringify(body)}`)
  })

  it('host can transfer to any of multiple seated humans', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[2]

    const { tableId } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'east', players[1].sessionId, players[1].playerId)
    await sitAtTable(server.baseUrl, tableId, 'south', target.sessionId, target.playerId)

    const { status, body } = await transferHost(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId)

    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`)
    assert.equal(body.hostPlayerId, target.playerId, 'Host should transfer to player 3 at south')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('new host can perform host-only actions after transfer', { timeout: 10000 }, async () => {
    const originalHost = players[0]
    const newHost = players[1]

    const { tableId } = await createTableApi(server.baseUrl, originalHost.sessionId, originalHost.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', originalHost.sessionId, originalHost.playerId)
    await sitAtTable(server.baseUrl, tableId, 'south', newHost.sessionId, newHost.playerId)

    await transferHost(server.baseUrl, tableId, newHost.playerId, originalHost.sessionId, originalHost.playerId)

    const botResult = await addBot(server.baseUrl, tableId, 'east', newHost.sessionId, newHost.playerId)
    assert.ok(!botResult.error, 'New host should be able to add bots')

    const oldHostBotResult = await fetch(`${server.baseUrl}/api/tables/${tableId}/add-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': originalHost.sessionId, 'x-player-id': originalHost.playerId },
      body: JSON.stringify({ seat: 'west' }),
    })
    assert.equal(oldHostBotResult.status, 403, 'Original host should no longer have host privileges')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })
})
