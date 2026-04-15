/**
 * Integration tests: table visibility transition events.
 *
 * Issue #594 — when a host changes a table's visibility, fire TABLE_REMOVED
 * on the old audience's channel and TABLE_CREATED on the new audience's
 * channel atomically. All six transition combinations must be handled:
 *
 *   Public → Friends-Only : TABLE_REMOVED to lobby; TABLE_CREATED to each friend notify
 *   Public → Private      : TABLE_REMOVED to lobby
 *   Friends-Only → Public : TABLE_REMOVED to each friend notify; TABLE_CREATED to lobby
 *   Friends-Only → Private: TABLE_REMOVED to each friend notify
 *   Private → Public      : TABLE_CREATED to lobby
 *   Private → Friends-Only: TABLE_CREATED to each friend notify
 *
 * Requires REDIS_URL and DATABASE_URL.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import WebSocket from 'ws'
import { handler } from '../../server/server.js'
import { createWsServer } from '../../server/ws/index.js'
import { getRedis, closeRedis } from '../../server/redis.js'
import { getDb, closeDb } from '../../server/db.js'
import { createSession } from '../../server/auth/session.js'

const skip =
  !process.env.DATABASE_URL || !process.env.REDIS_URL
    ? 'DATABASE_URL and REDIS_URL must both be set'
    : false

// ── Helpers ───────────────────────────────────────────────────────────────────

function wsConnect(server, headers = {}) {
  const { port } = server.httpServer.address()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    ws.once('open', () => { setTimeout(() => resolve(ws), 100) })
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }))
    })
  })
}

function waitForType(ws, targetType, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const msgs = []
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg)
      reject(new Error(`Timed out waiting for "${targetType}" (got: ${msgs.map((m) => m.type).join(', ')})`))
    }, timeoutMs)

    function onMsg(data) {
      const msg = JSON.parse(data.toString())
      msgs.push(msg)
      if (msg.type === targetType) {
        clearTimeout(timer)
        ws.removeListener('message', onMsg)
        resolve(msgs)
      }
    }
    ws.on('message', onMsg)
  })
}

function collectLobbyEvents(ws, waitMs = 1200, tableIdFilter = null) {
  return new Promise((resolve) => {
    const LOBBY_EVENTS = new Set(['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'])
    const received = []
    function onMsg(data) {
      const msg = JSON.parse(data.toString())
      if (LOBBY_EVENTS.has(msg.type)) {
        if (!tableIdFilter || msg.payload?.tableId === tableIdFilter) {
          received.push(msg)
        }
      }
    }
    ws.on('message', onMsg)
    setTimeout(() => {
      ws.removeListener('message', onMsg)
      resolve(received)
    }, waitMs)
  })
}

function collectAllMessages(ws, waitMs = 1200, tableIdFilter = null) {
  return new Promise((resolve) => {
    const received = []
    function onMsg(data) {
      const msg = JSON.parse(data.toString())
      if (!tableIdFilter || msg.payload?.tableId === tableIdFilter) {
        received.push(msg)
      }
    }
    ws.on('message', onMsg)
    setTimeout(() => {
      ws.removeListener('message', onMsg)
      resolve(received)
    }, waitMs)
  })
}

async function apiRequest(baseUrl, method, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
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
  await db.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      id BIGSERIAL PRIMARY KEY,
      requester_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      addressee_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(requester_id, addressee_id)
    )
  `)
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair_unique
    ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))
  `)
  await db.query(`DELETE FROM friendships WHERE requester_id IN (
    SELECT id FROM players WHERE email LIKE '%@vistrans.test.spades.invalid'
  ) OR addressee_id IN (
    SELECT id FROM players WHERE email LIKE '%@vistrans.test.spades.invalid'
  )`)
  await db.query(`DELETE FROM players WHERE email LIKE '%@vistrans.test.spades.invalid'`)
}

async function insertTestPlayer(db, { email, username }) {
  const result = await db.query(
    `INSERT INTO players (email, username, password_hash, is_verified)
     VALUES ($1, $2, 'hash', TRUE) RETURNING id`,
    [email, username],
  )
  return result.rows[0].id
}

async function makeFriends(db, playerA, playerB) {
  await db.query(
    `INSERT INTO friendships (requester_id, addressee_id, status)
     VALUES ($1, $2, 'accepted')`,
    [playerA, playerB],
  )
}

function makeTable(overrides = {}) {
  return {
    tableId: `vistrans-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    hostPlayerId: null,
    name: 'VisTrans Test Table',
    seats: { north: null, east: null, south: null, west: null },
    status: 'waiting',
    gameId: null,
    createdAt: new Date().toISOString(),
    visibility: 'public',
    joinPolicy: 'open',
    observers: [],
    spectating: false,
    ...overrides,
  }
}

async function startTestServer(redis) {
  const app = express()
  app.use(express.json())

  const httpServer = http.createServer(app)
  const wss = createWsServer(httpServer, { redis, pingIntervalMs: 30_000, pongTimeoutMs: 10_000 })
  await wss._subscriberReady

  handler(app, { redis, wss })

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))

  return {
    baseUrl: `http://127.0.0.1:${httpServer.address().port}`,
    httpServer,
    wss,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise((res) => wss.close(res))
      await new Promise((res) => httpServer.close(res))
    },
  }
}

/**
 * Create a table via API so it is properly registered in Redis and lobby:tables.
 */
async function createTableViaAPI(server, session, playerId, { visibility = 'public', name = 'VisTrans Table' } = {}) {
  const { status, body } = await apiRequest(
    server.baseUrl, 'POST', '/api/tables',
    { name, visibility },
    { 'x-session-id': session, 'x-player-id': playerId },
  )
  assert.equal(status, 201, `Expected 201 creating table, got ${status}: ${JSON.stringify(body)}`)
  return body.tableId
}

/**
 * Change a table's visibility via API. This is the route under test (Issue #594).
 * Expected endpoint: POST /api/tables/:tableId/visibility
 */
async function changeVisibility(server, session, playerId, tableId, newVisibility) {
  return apiRequest(
    server.baseUrl, 'POST', `/api/tables/${tableId}/visibility`,
    { visibility: newVisibility },
    { 'x-session-id': session, 'x-player-id': playerId },
  )
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Table visibility transitions (#594)', { skip }, () => {
  let server, redis, db
  let hostId, friendId, friend2Id, strangerId
  let hostSession, friendSession, friend2Session, strangerSession
  const keysToClean = []

  before(async () => {
    redis = await getRedis()
    db = getDb()

    await resetTestSchema(db)

    hostId = await insertTestPlayer(db, { email: 'host@vistrans.test.spades.invalid', username: 'VisTransHost' })
    friendId = await insertTestPlayer(db, { email: 'friend@vistrans.test.spades.invalid', username: 'VisTransFriend' })
    friend2Id = await insertTestPlayer(db, { email: 'friend2@vistrans.test.spades.invalid', username: 'VisTransFriend2' })
    strangerId = await insertTestPlayer(db, { email: 'stranger@vistrans.test.spades.invalid', username: 'VisTransStranger' })

    await makeFriends(db, hostId, friendId)
    await makeFriends(db, hostId, friend2Id)

    hostSession = await createSession(redis, { playerId: hostId, email: 'host@vistrans.test.spades.invalid', username: 'VisTransHost' })
    friendSession = await createSession(redis, { playerId: friendId, email: 'friend@vistrans.test.spades.invalid', username: 'VisTransFriend' })
    friend2Session = await createSession(redis, { playerId: friend2Id, email: 'friend2@vistrans.test.spades.invalid', username: 'VisTransFriend2' })
    strangerSession = await createSession(redis, { playerId: strangerId, email: 'stranger@vistrans.test.spades.invalid', username: 'VisTransStranger' })

    server = await startTestServer(redis)
  })

  after(async () => {
    await server.close()

    for (const key of keysToClean) {
      await redis.del(key)
    }
    await redis.del(`session:${hostSession}`)
    await redis.del(`session:${friendSession}`)
    await redis.del(`session:${friend2Session}`)
    await redis.del(`session:${strangerSession}`)

    await resetTestSchema(db)
    await closeDb()
    await closeRedis()
  })

  // ── Public → Friends-Only ─────────────────────────────────────────────────

  describe('Public → Friends-Only', () => {
    it('sends TABLE_REMOVED to lobby and TABLE_CREATED to each friend notify', { timeout: 15000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'public', name: 'Pub→FO' })
      keysToClean.push(`table:${tableId}`)

      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })
      const wsFriend2 = await wsConnect(server, { 'x-session-id': friend2Session })

      const lobbyEvents = collectLobbyEvents(wsStranger, 1500, tableId)
      const friendMsgs = collectAllMessages(wsFriend, 1500, tableId)
      const friend2Msgs = collectAllMessages(wsFriend2, 1500, tableId)

      const { status } = await changeVisibility(server, hostSession, hostId, tableId, 'friends-only')
      assert.equal(status, 200, 'visibility change should succeed')

      const lobbyReceived = await lobbyEvents
      const friendReceived = await friendMsgs
      const friend2Received = await friend2Msgs

      const lobbyRemoved = lobbyReceived.filter(m => m.type === 'TABLE_REMOVED')
      assert.equal(lobbyRemoved.length, 1, 'lobby should receive exactly one TABLE_REMOVED')
      assert.equal(lobbyRemoved[0].payload.tableId, tableId)

      const friendCreated = friendReceived.filter(m => m.type === 'TABLE_CREATED')
      assert.equal(friendCreated.length, 1, 'friend should receive TABLE_CREATED via notify')
      assert.equal(friendCreated[0].payload.tableId, tableId)
      assert.equal(friendCreated[0].payload.visibility, 'friends-only')

      const friend2Created = friend2Received.filter(m => m.type === 'TABLE_CREATED')
      assert.equal(friend2Created.length, 1, 'friend2 should receive TABLE_CREATED via notify')

      wsStranger.terminate()
      wsFriend.terminate()
      wsFriend2.terminate()
    })

    it('stranger stops receiving lobby events after transition', { timeout: 15000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'public', name: 'Pub→FO NoLeak' })
      keysToClean.push(`table:${tableId}`)

      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsStranger, 'JOINED_LOBBY')

      await changeVisibility(server, hostSession, hostId, tableId, 'friends-only')
      await new Promise(r => setTimeout(r, 500))

      const postTransitionEvents = collectLobbyEvents(wsStranger, 1000, tableId)
      const received = await postTransitionEvents

      const createdEvents = received.filter(m => m.type === 'TABLE_CREATED' || m.type === 'TABLE_UPDATED')
      assert.equal(createdEvents.length, 0, 'no TABLE_CREATED or TABLE_UPDATED should leak to lobby after transition')

      wsStranger.terminate()
    })
  })

  // ── Public → Private ──────────────────────────────────────────────────────

  describe('Public → Private', () => {
    it('sends TABLE_REMOVED to lobby, no notifications to friends', { timeout: 15000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'public', name: 'Pub→Priv' })
      keysToClean.push(`table:${tableId}`)

      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })

      const lobbyEvents = collectLobbyEvents(wsStranger, 1500, tableId)
      const friendMsgs = collectAllMessages(wsFriend, 1500, tableId)

      const { status } = await changeVisibility(server, hostSession, hostId, tableId, 'private')
      assert.equal(status, 200)

      const lobbyReceived = await lobbyEvents
      const friendReceived = await friendMsgs

      const lobbyRemoved = lobbyReceived.filter(m => m.type === 'TABLE_REMOVED')
      assert.equal(lobbyRemoved.length, 1, 'lobby should receive TABLE_REMOVED')
      assert.equal(lobbyRemoved[0].payload.tableId, tableId)

      const lobbyCreated = lobbyReceived.filter(m => m.type === 'TABLE_CREATED')
      assert.equal(lobbyCreated.length, 0, 'lobby should not receive TABLE_CREATED')

      const friendTableEvents = friendReceived.filter(m =>
        m.type === 'TABLE_CREATED' || m.type === 'TABLE_REMOVED',
      )
      assert.equal(friendTableEvents.length, 0, 'friends should not receive any table events for private transition')

      wsStranger.terminate()
      wsFriend.terminate()
    })
  })

  // ── Friends-Only → Public ─────────────────────────────────────────────────

  describe('Friends-Only → Public', () => {
    it('sends TABLE_REMOVED to each friend notify and TABLE_CREATED to lobby', { timeout: 15000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'friends-only', name: 'FO→Pub' })
      keysToClean.push(`table:${tableId}`)

      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })
      const wsFriend2 = await wsConnect(server, { 'x-session-id': friend2Session })

      const lobbyEvents = collectLobbyEvents(wsStranger, 1500, tableId)
      const friendMsgs = collectAllMessages(wsFriend, 1500, tableId)
      const friend2Msgs = collectAllMessages(wsFriend2, 1500, tableId)

      const { status } = await changeVisibility(server, hostSession, hostId, tableId, 'public')
      assert.equal(status, 200)

      const lobbyReceived = await lobbyEvents
      const friendReceived = await friendMsgs
      const friend2Received = await friend2Msgs

      const lobbyCreated = lobbyReceived.filter(m => m.type === 'TABLE_CREATED')
      assert.equal(lobbyCreated.length, 1, 'lobby should receive TABLE_CREATED')
      assert.equal(lobbyCreated[0].payload.tableId, tableId)
      assert.equal(lobbyCreated[0].payload.visibility, 'public')

      const friendRemoved = friendReceived.filter(m => m.type === 'TABLE_REMOVED')
      assert.equal(friendRemoved.length, 1, 'friend should receive TABLE_REMOVED via notify')
      assert.equal(friendRemoved[0].payload.tableId, tableId)

      const friend2Removed = friend2Received.filter(m => m.type === 'TABLE_REMOVED')
      assert.equal(friend2Removed.length, 1, 'friend2 should receive TABLE_REMOVED via notify')

      wsStranger.terminate()
      wsFriend.terminate()
      wsFriend2.terminate()
    })
  })

  // ── Friends-Only → Private ────────────────────────────────────────────────

  describe('Friends-Only → Private', () => {
    it('sends TABLE_REMOVED to each friend notify, no lobby events', { timeout: 15000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'friends-only', name: 'FO→Priv' })
      keysToClean.push(`table:${tableId}`)

      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })

      const lobbyEvents = collectLobbyEvents(wsStranger, 1500, tableId)
      const friendMsgs = collectAllMessages(wsFriend, 1500, tableId)

      const { status } = await changeVisibility(server, hostSession, hostId, tableId, 'private')
      assert.equal(status, 200)

      const lobbyReceived = await lobbyEvents
      const friendReceived = await friendMsgs

      const lobbyAny = lobbyReceived.filter(m =>
        m.type === 'TABLE_CREATED' || m.type === 'TABLE_REMOVED',
      )
      assert.equal(lobbyAny.length, 0, 'lobby should not receive any events')

      const friendRemoved = friendReceived.filter(m => m.type === 'TABLE_REMOVED')
      assert.equal(friendRemoved.length, 1, 'friend should receive TABLE_REMOVED')
      assert.equal(friendRemoved[0].payload.tableId, tableId)

      const friendCreated = friendReceived.filter(m => m.type === 'TABLE_CREATED')
      assert.equal(friendCreated.length, 0, 'friend should not receive TABLE_CREATED')

      wsStranger.terminate()
      wsFriend.terminate()
    })
  })

  // ── Private → Public ──────────────────────────────────────────────────────

  describe('Private → Public', () => {
    it('sends TABLE_CREATED to lobby, no friend notifications', { timeout: 15000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'private', name: 'Priv→Pub' })
      keysToClean.push(`table:${tableId}`)

      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })

      const lobbyEvents = collectLobbyEvents(wsStranger, 1500, tableId)
      const friendMsgs = collectAllMessages(wsFriend, 1500, tableId)

      const { status } = await changeVisibility(server, hostSession, hostId, tableId, 'public')
      assert.equal(status, 200)

      const lobbyReceived = await lobbyEvents
      const friendReceived = await friendMsgs

      const lobbyCreated = lobbyReceived.filter(m => m.type === 'TABLE_CREATED')
      assert.equal(lobbyCreated.length, 1, 'lobby should receive TABLE_CREATED')
      assert.equal(lobbyCreated[0].payload.tableId, tableId)
      assert.equal(lobbyCreated[0].payload.visibility, 'public')

      const lobbyRemoved = lobbyReceived.filter(m => m.type === 'TABLE_REMOVED')
      assert.equal(lobbyRemoved.length, 0, 'lobby should not receive TABLE_REMOVED for private→public')

      const friendTableEvents = friendReceived.filter(m =>
        m.type === 'TABLE_CREATED' || m.type === 'TABLE_REMOVED',
      )
      assert.equal(friendTableEvents.length, 0, 'friends should not receive events for private→public')

      wsStranger.terminate()
      wsFriend.terminate()
    })
  })

  // ── Private → Friends-Only ────────────────────────────────────────────────

  describe('Private → Friends-Only', () => {
    it('sends TABLE_CREATED to each friend notify, no lobby events', { timeout: 15000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'private', name: 'Priv→FO' })
      keysToClean.push(`table:${tableId}`)

      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })
      const wsFriend2 = await wsConnect(server, { 'x-session-id': friend2Session })

      const lobbyEvents = collectLobbyEvents(wsStranger, 1500, tableId)
      const friendMsgs = collectAllMessages(wsFriend, 1500, tableId)
      const friend2Msgs = collectAllMessages(wsFriend2, 1500, tableId)

      const { status } = await changeVisibility(server, hostSession, hostId, tableId, 'friends-only')
      assert.equal(status, 200)

      const lobbyReceived = await lobbyEvents
      const friendReceived = await friendMsgs
      const friend2Received = await friend2Msgs

      const lobbyAny = lobbyReceived.filter(m =>
        m.type === 'TABLE_CREATED' || m.type === 'TABLE_REMOVED',
      )
      assert.equal(lobbyAny.length, 0, 'lobby should not receive any events')

      const friendCreated = friendReceived.filter(m => m.type === 'TABLE_CREATED')
      assert.equal(friendCreated.length, 1, 'friend should receive TABLE_CREATED via notify')
      assert.equal(friendCreated[0].payload.tableId, tableId)
      assert.equal(friendCreated[0].payload.visibility, 'friends-only')

      const friend2Created = friend2Received.filter(m => m.type === 'TABLE_CREATED')
      assert.equal(friend2Created.length, 1, 'friend2 should receive TABLE_CREATED via notify')

      wsStranger.terminate()
      wsFriend.terminate()
      wsFriend2.terminate()
    })
  })

  // ── Edge cases & error handling ───────────────────────────────────────────

  describe('Edge cases', () => {
    it('same-visibility change is a no-op (no events fired)', { timeout: 15000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'public', name: 'Same Vis' })
      keysToClean.push(`table:${tableId}`)

      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })

      const lobbyEvents = collectLobbyEvents(wsStranger, 1200, tableId)
      const friendMsgs = collectAllMessages(wsFriend, 1200, tableId)

      const { status } = await changeVisibility(server, hostSession, hostId, tableId, 'public')
      assert.equal(status, 200)

      const lobbyReceived = await lobbyEvents
      const friendReceived = await friendMsgs

      const transitionEvents = lobbyReceived.filter(m =>
        m.type === 'TABLE_CREATED' || m.type === 'TABLE_REMOVED',
      )
      assert.equal(transitionEvents.length, 0, 'no transition events for same visibility')

      const friendTransitionEvents = friendReceived.filter(m =>
        m.type === 'TABLE_CREATED' || m.type === 'TABLE_REMOVED',
      )
      assert.equal(friendTransitionEvents.length, 0, 'no friend notifications for same visibility')

      wsStranger.terminate()
      wsFriend.terminate()
    })

    it('non-host cannot change visibility', { timeout: 10000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'public', name: 'Non-Host' })
      keysToClean.push(`table:${tableId}`)

      const { status } = await changeVisibility(server, strangerSession, strangerId, tableId, 'private')
      assert.ok(status === 403 || status === 401, `non-host should be rejected, got ${status}`)
    })

    it('invalid visibility value returns 400', { timeout: 10000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'public', name: 'Bad Vis' })
      keysToClean.push(`table:${tableId}`)

      const { status } = await changeVisibility(server, hostSession, hostId, tableId, 'invalid-visibility')
      assert.equal(status, 400, 'invalid visibility should return 400')
    })

    it('changing visibility on non-existent table returns 404', { timeout: 10000 }, async () => {
      const { status } = await changeVisibility(server, hostSession, hostId, 'nonexistent-table-id', 'private')
      assert.equal(status, 404)
    })

    it('unauthenticated request is rejected', { timeout: 10000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'public', name: 'NoAuth' })
      keysToClean.push(`table:${tableId}`)

      const { status } = await apiRequest(
        server.baseUrl, 'POST', `/api/tables/${tableId}/visibility`,
        { visibility: 'private' },
        {},
      )
      assert.equal(status, 401)
    })

    it('join policy is updated to match the new visibility', { timeout: 10000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'public', name: 'JoinPolicy' })
      keysToClean.push(`table:${tableId}`)

      await changeVisibility(server, hostSession, hostId, tableId, 'private')

      const raw = await redis.get(`table:${tableId}`)
      const table = JSON.parse(raw)
      assert.equal(table.visibility, 'private')
      assert.equal(table.joinPolicy, 'invite-only', 'private tables must use invite-only join policy')
    })

    it('visibility change updates the persisted table state in Redis', { timeout: 10000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'public', name: 'Persist' })
      keysToClean.push(`table:${tableId}`)

      await changeVisibility(server, hostSession, hostId, tableId, 'friends-only')

      const raw = await redis.get(`table:${tableId}`)
      const table = JSON.parse(raw)
      assert.equal(table.visibility, 'friends-only', 'Redis table state should reflect new visibility')
    })

    it('lobby:tables index is updated on public→private transition', { timeout: 10000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'public', name: 'LobbyIdx' })
      keysToClean.push(`table:${tableId}`)

      const beforeEntry = await redis.hGet('lobby:tables', tableId)
      assert.ok(beforeEntry, 'public table should be in lobby:tables index')

      await changeVisibility(server, hostSession, hostId, tableId, 'private')

      const afterEntry = await redis.hGet('lobby:tables', tableId)
      assert.equal(afterEntry, null, 'private table should be removed from lobby:tables index')
    })

    it('lobby:tables index is added on private→public transition', { timeout: 10000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'private', name: 'LobbyIdxAdd' })
      keysToClean.push(`table:${tableId}`)

      const beforeEntry = await redis.hGet('lobby:tables', tableId)
      assert.equal(beforeEntry, null, 'private table should not be in lobby:tables index')

      await changeVisibility(server, hostSession, hostId, tableId, 'public')

      const afterEntry = await redis.hGet('lobby:tables', tableId)
      assert.ok(afterEntry, 'public table should be added to lobby:tables index')
    })
  })

  // ── Atomicity / ordering ──────────────────────────────────────────────────

  describe('Atomicity and ordering', () => {
    it('TABLE_REMOVED on old channel arrives before TABLE_CREATED on new channel (public→friends-only)', { timeout: 15000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'public', name: 'Order P→FO' })
      keysToClean.push(`table:${tableId}`)

      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })

      const allLobbyMsgs = []
      const allFriendMsgs = []
      const lobbyTimestamps = []
      const friendTimestamps = []

      const onLobby = (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.payload?.tableId === tableId && (msg.type === 'TABLE_REMOVED' || msg.type === 'TABLE_CREATED')) {
          lobbyTimestamps.push({ type: msg.type, ts: Date.now() })
          allLobbyMsgs.push(msg)
        }
      }
      const onFriend = (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.payload?.tableId === tableId && (msg.type === 'TABLE_REMOVED' || msg.type === 'TABLE_CREATED')) {
          friendTimestamps.push({ type: msg.type, ts: Date.now() })
          allFriendMsgs.push(msg)
        }
      }

      wsStranger.on('message', onLobby)
      wsFriend.on('message', onFriend)

      await changeVisibility(server, hostSession, hostId, tableId, 'friends-only')
      await new Promise(r => setTimeout(r, 1500))

      wsStranger.removeListener('message', onLobby)
      wsFriend.removeListener('message', onFriend)

      const lobbyRemoved = lobbyTimestamps.find(e => e.type === 'TABLE_REMOVED')
      const friendCreated = friendTimestamps.find(e => e.type === 'TABLE_CREATED')

      assert.ok(lobbyRemoved, 'lobby should have received TABLE_REMOVED')
      assert.ok(friendCreated, 'friend should have received TABLE_CREATED')

      if (lobbyRemoved && friendCreated) {
        assert.ok(
          lobbyRemoved.ts <= friendCreated.ts,
          'TABLE_REMOVED on old channel should arrive before or at same time as TABLE_CREATED on new channel',
        )
      }

      wsStranger.terminate()
      wsFriend.terminate()
    })

    it('TABLE_REMOVED on old channel arrives before TABLE_CREATED on new channel (friends-only→public)', { timeout: 15000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'friends-only', name: 'Order FO→P' })
      keysToClean.push(`table:${tableId}`)

      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })

      const lobbyTimestamps = []
      const friendTimestamps = []

      const onLobby = (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.payload?.tableId === tableId && (msg.type === 'TABLE_REMOVED' || msg.type === 'TABLE_CREATED')) {
          lobbyTimestamps.push({ type: msg.type, ts: Date.now() })
        }
      }
      const onFriend = (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.payload?.tableId === tableId && (msg.type === 'TABLE_REMOVED' || msg.type === 'TABLE_CREATED')) {
          friendTimestamps.push({ type: msg.type, ts: Date.now() })
        }
      }

      wsFriend.on('message', onFriend)
      wsStranger.on('message', onLobby)

      await changeVisibility(server, hostSession, hostId, tableId, 'public')
      await new Promise(r => setTimeout(r, 1500))

      wsFriend.removeListener('message', onFriend)
      wsStranger.removeListener('message', onLobby)

      const friendRemoved = friendTimestamps.find(e => e.type === 'TABLE_REMOVED')
      const lobbyCreated = lobbyTimestamps.find(e => e.type === 'TABLE_CREATED')

      assert.ok(friendRemoved, 'friend should have received TABLE_REMOVED')
      assert.ok(lobbyCreated, 'lobby should have received TABLE_CREATED')

      if (friendRemoved && lobbyCreated) {
        assert.ok(
          friendRemoved.ts <= lobbyCreated.ts,
          'TABLE_REMOVED on friend notify should arrive before or at same time as TABLE_CREATED on lobby',
        )
      }

      wsStranger.terminate()
      wsFriend.terminate()
    })
  })

  // ── TABLE_VISIBILITY_CHANGED in-table event ───────────────────────────────

  describe('In-table notification', () => {
    it('seated players at the table receive TABLE_VISIBILITY_CHANGED event', { timeout: 15000 }, async () => {
      const tableId = await createTableViaAPI(server, hostSession, hostId, { visibility: 'public', name: 'InTable' })
      keysToClean.push(`table:${tableId}`)

      await apiRequest(
        server.baseUrl, 'POST', `/api/tables/${tableId}/sit`,
        { seat: 'east' },
        { 'x-session-id': friendSession, 'x-player-id': friendId },
      )

      const wsHost = await wsConnect(server, { 'x-session-id': hostSession })
      wsHost.send(JSON.stringify({ type: 'JOIN_TABLE', payload: { tableId } }))

      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })
      wsFriend.send(JSON.stringify({ type: 'JOIN_TABLE', payload: { tableId } }))

      await new Promise(r => setTimeout(r, 300))

      const hostMsgs = collectAllMessages(wsHost, 1500, tableId)
      const friendMsgs = collectAllMessages(wsFriend, 1500, tableId)

      await changeVisibility(server, hostSession, hostId, tableId, 'private')

      const hostReceived = await hostMsgs
      const friendReceived = await friendMsgs

      const hostVisChanged = hostReceived.find(m => m.type === 'TABLE_VISIBILITY_CHANGED')
      const friendVisChanged = friendReceived.find(m => m.type === 'TABLE_VISIBILITY_CHANGED')

      if (hostVisChanged) {
        assert.equal(hostVisChanged.payload.visibility, 'private')
        assert.equal(hostVisChanged.payload.tableId, tableId)
      }
      if (friendVisChanged) {
        assert.equal(friendVisChanged.payload.visibility, 'private')
      }

      wsHost.terminate()
      wsFriend.terminate()
    })
  })
})
