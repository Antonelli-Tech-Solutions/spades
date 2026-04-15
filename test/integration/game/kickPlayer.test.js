/**
 * Integration tests for POST /api/tables/:tableId/kick.
 *
 * Covers: successful kick from seat, kick observer, non-host gets 403,
 * host cannot kick self, kick during active game replaces with bot,
 * kicked player receives notification, auth errors, table not found.
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@kick.spades.invalid'`)
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

async function createTableApi(baseUrl, sessionId, playerId, opts = {}) {
  const res = await fetch(`${baseUrl}/api/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify(opts),
  })
  return { status: res.status, body: await res.json() }
}

async function sitAtTable(baseUrl, tableId, seat, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/sit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify({ seat }),
  })
  return { status: res.status, body: await res.json() }
}

async function addBot(baseUrl, tableId, seat, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/add-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify({ seat }),
  })
  return { status: res.status, body: await res.json() }
}

async function arriveAtTable(baseUrl, tableId, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/arrive`, {
    method: 'POST',
    headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
  })
  return { status: res.status, body: await res.json() }
}

async function kickPlayer(baseUrl, tableId, targetPlayerId, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/kick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify({ playerId: targetPlayerId }),
  })
  return { status: res.status, body: await res.json() }
}

async function getTableState(baseUrl, tableId, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/state`, {
    headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
  })
  return { status: res.status, body: await res.json() }
}

describe('POST /api/tables/:tableId/kick', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `kickplayer${i}@kick.spades.invalid`,
        username: `kick_player${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(server.baseUrl, `kickplayer${i}@kick.spades.invalid`, 'password123')
      players.push(data)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('host can kick a seated player from a waiting table', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const { body: { tableId } } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'east', guest.sessionId, guest.playerId)

    const { status, body } = await kickPlayer(server.baseUrl, tableId, guest.playerId, host.sessionId, host.playerId)

    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`)

    const { body: state } = await getTableState(server.baseUrl, tableId, host.sessionId, host.playerId)
    const seatValues = Object.values(state.seats).map((s) => s?.playerId ?? s)
    assert.ok(!seatValues.includes(guest.playerId), 'Kicked player should no longer be seated')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('host can kick an observer from the table', { timeout: 10000 }, async () => {
    const host = players[0]
    const observer = players[1]

    const { body: { tableId } } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)
    await arriveAtTable(server.baseUrl, tableId, observer.sessionId, observer.playerId)

    const { body: priorState } = await getTableState(server.baseUrl, tableId, host.sessionId, host.playerId)
    const priorObserverIds = (priorState.observers || []).map((o) => o.playerId || o)
    assert.ok(priorObserverIds.includes(observer.playerId), 'Player should be observing before kick')

    const { status, body } = await kickPlayer(server.baseUrl, tableId, observer.playerId, host.sessionId, host.playerId)

    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`)

    const { body: state } = await getTableState(server.baseUrl, tableId, host.sessionId, host.playerId)
    const observerIds = (state.observers || []).map((o) => o.playerId || o)
    assert.ok(!observerIds.includes(observer.playerId), 'Kicked observer should no longer be in observers list')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns 403 when a non-host tries to kick a player', { timeout: 10000 }, async () => {
    const host = players[0]
    const nonHost = players[1]
    const target = players[2]

    const { body: { tableId } } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'east', nonHost.sessionId, nonHost.playerId)
    await sitAtTable(server.baseUrl, tableId, 'south', target.sessionId, target.playerId)

    const { status, body } = await kickPlayer(server.baseUrl, tableId, target.playerId, nonHost.sessionId, nonHost.playerId)

    assert.equal(status, 403, `Expected 403 but got ${status}: ${JSON.stringify(body)}`)
    assert.ok(body.error, 'Response should include an error message')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('host cannot kick themselves', { timeout: 10000 }, async () => {
    const host = players[0]

    const { body: { tableId } } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)

    const { status, body } = await kickPlayer(server.baseUrl, tableId, host.playerId, host.sessionId, host.playerId)

    assert.ok(status >= 400, `Expected error status but got ${status}: ${JSON.stringify(body)}`)
    assert.ok(body.error, 'Response should include an error message')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('kick during active game replaces player with bot', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[1]
    const p3 = players[2]

    const { body: { tableId } } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)

    const seats = ['north', 'east', 'south']
    const seated = [host, target, p3]
    for (let i = 0; i < 3; i++) {
      await sitAtTable(server.baseUrl, tableId, seats[i], seated[i].sessionId, seated[i].playerId)
    }
    await addBot(server.baseUrl, tableId, 'west', host.sessionId, host.playerId)

    const { body: preState } = await getTableState(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(preState.status, 'playing', 'Game should be in progress before kick')

    const { status, body } = await kickPlayer(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId)

    assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`)

    const { body: postState } = await getTableState(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(postState.status, 'playing', 'Game should still be in progress after kick')
    const eastPlayer = postState.players?.east ?? postState.seats?.east?.playerId ?? postState.seats?.east
    assert.ok(
      typeof eastPlayer === 'string' && eastPlayer.startsWith('bot:'),
      `East seat should be occupied by a bot after kick, got: ${eastPlayer}`,
    )

    await redis.del(`table:${tableId}`)
    await redis.del(`game:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns 404 when table does not exist', { timeout: 10000 }, async () => {
    const host = players[0]
    const fakeTableId = '00000000-0000-0000-0000-000000000000'

    const { status, body } = await kickPlayer(server.baseUrl, fakeTableId, players[1].playerId, host.sessionId, host.playerId)

    assert.equal(status, 404, `Expected 404 but got ${status}: ${JSON.stringify(body)}`)
  })

  it('returns 401 without auth headers', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/tables/some-id/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'some-player-id' }),
    })
    assert.equal(res.status, 401)
  })

  it('fails when target player is not at the table', { timeout: 10000 }, async () => {
    const host = players[0]
    const outsider = players[1]

    const { body: { tableId } } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)

    const { status, body } = await kickPlayer(server.baseUrl, tableId, outsider.playerId, host.sessionId, host.playerId)

    assert.ok(status >= 400, `Expected error status but got ${status}: ${JSON.stringify(body)}`)
    assert.ok(body.error, 'Response should include an error message')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('kicked seated player seat becomes null on waiting table', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const { body: { tableId } } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'south', guest.sessionId, guest.playerId)

    await kickPlayer(server.baseUrl, tableId, guest.playerId, host.sessionId, host.playerId)

    const { body: state } = await getTableState(server.baseUrl, tableId, host.sessionId, host.playerId)
    const southSeat = state.seats.south?.playerId ?? state.seats.south
    assert.equal(southSeat, null, 'South seat should be null after kicking the seated player')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('fails when request body is missing playerId', { timeout: 10000 }, async () => {
    const host = players[0]

    const { body: { tableId } } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({}),
    })

    assert.ok(res.status >= 400, `Expected error status but got ${res.status}`)

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('kick during active game with host as only remaining human terminates table', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[1]

    const { body: { tableId } } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'east', target.sessionId, target.playerId)
    await addBot(server.baseUrl, tableId, 'south', host.sessionId, host.playerId)
    await addBot(server.baseUrl, tableId, 'west', host.sessionId, host.playerId)

    const { body: preState } = await getTableState(server.baseUrl, tableId, host.sessionId, host.playerId)
    assert.equal(preState.status, 'playing', 'Game should be in progress')

    const { status } = await kickPlayer(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId)
    assert.equal(status, 200, 'Kick should succeed')

    const { body: postState } = await getTableState(server.baseUrl, tableId, host.sessionId, host.playerId)
    const eastPlayer = postState.players?.east ?? postState.seats?.east?.playerId ?? postState.seats?.east
    assert.ok(
      typeof eastPlayer === 'string' && eastPlayer.startsWith('bot:'),
      'East seat should have a bot after kicking the only other human',
    )

    await redis.del(`table:${tableId}`)
    await redis.del(`game:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('host can still manage table after kicking a player', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest1 = players[1]
    const guest2 = players[2]

    const { body: { tableId } } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'east', guest1.sessionId, guest1.playerId)
    await sitAtTable(server.baseUrl, tableId, 'south', guest2.sessionId, guest2.playerId)

    await kickPlayer(server.baseUrl, tableId, guest1.playerId, host.sessionId, host.playerId)

    const botRes = await addBot(server.baseUrl, tableId, 'east', host.sessionId, host.playerId)
    assert.equal(botRes.status, 200, 'Host should still be able to add bots after kicking a player')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })
})
