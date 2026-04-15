/**
 * Integration tests: lobby WebSocket event routing by table visibility.
 *
 * Issue #593 — route TABLE_CREATED, TABLE_UPDATED, TABLE_REMOVED based on
 * table visibility:
 *   - Public    → broadcast on the `lobby` channel
 *   - Friends-Only → notify each host friend via `player:{friendId}:notify`
 *   - Private   → no broadcast at all
 *
 * Requires REDIS_URL and DATABASE_URL.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
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

/**
 * Collect lobby-channel events (TABLE_CREATED/TABLE_UPDATED/TABLE_REMOVED)
 * received within `waitMs`. Optionally filter by tableId.
 */
function collectLobbyEvents(ws, waitMs = 800, tableIdFilter = null) {
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

/**
 * Collect all messages of any type received within `waitMs`.
 * Optionally filter by tableId in payload.
 */
function collectAllMessages(ws, waitMs = 800, tableIdFilter = null) {
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
    SELECT id FROM players WHERE email LIKE '%@visroute.test.spades.invalid'
  ) OR addressee_id IN (
    SELECT id FROM players WHERE email LIKE '%@visroute.test.spades.invalid'
  )`)
  await db.query(`DELETE FROM players WHERE email LIKE '%@visroute.test.spades.invalid'`)
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
    tableId: `visroute-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    hostPlayerId: null,
    name: 'VisRoute Test Table',
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

// ── Test server setup ─────────────────────────────────────────────────────────

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

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Lobby event routing by table visibility (#593)', { skip }, () => {
  let server, redis, db
  let hostId, friendId, strangerId
  let hostSession, friendSession, strangerSession
  const keysToClean = []

  before(async () => {
    redis = await getRedis()
    db = getDb()

    await resetTestSchema(db)

    hostId = await insertTestPlayer(db, { email: 'host@visroute.test.spades.invalid', username: 'VisRouteHost' })
    friendId = await insertTestPlayer(db, { email: 'friend@visroute.test.spades.invalid', username: 'VisRouteFriend' })
    strangerId = await insertTestPlayer(db, { email: 'stranger@visroute.test.spades.invalid', username: 'VisRouteStranger' })

    await makeFriends(db, hostId, friendId)

    hostSession = await createSession(redis, { playerId: hostId, email: 'host@visroute.test.spades.invalid', username: 'VisRouteHost' })
    friendSession = await createSession(redis, { playerId: friendId, email: 'friend@visroute.test.spades.invalid', username: 'VisRouteFriend' })
    strangerSession = await createSession(redis, { playerId: strangerId, email: 'stranger@visroute.test.spades.invalid', username: 'VisRouteStranger' })

    server = await startTestServer(redis)
  })

  after(async () => {
    await server.close()

    for (const key of keysToClean) {
      await redis.del(key)
    }
    await redis.del(`session:${hostSession}`)
    await redis.del(`session:${friendSession}`)
    await redis.del(`session:${strangerSession}`)

    await resetTestSchema(db)
    await closeDb()
    await closeRedis()
  })

  // ── Public tables → lobby channel ────────────────────────────────────────

  describe('Public tables broadcast on the lobby channel', () => {
    it('TABLE_CREATED for a public table is broadcast on the lobby channel', { timeout: 15000 }, async () => {
      const ws = await wsConnect(server, { 'x-session-id': friendSession })
      ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(ws, 'JOINED_LOBBY')

      const received = []
      const onMsg = (data) => received.push(JSON.parse(data.toString()))
      ws.on('message', onMsg)

      const { status, body } = await apiRequest(
        server.baseUrl, 'POST', '/api/tables',
        { name: 'Public Vis Route Test' },
        { 'x-session-id': hostSession, 'x-player-id': hostId },
      )
      assert.equal(status, 201)
      const { tableId } = body
      keysToClean.push(`table:${tableId}`)

      let msg
      const deadline = Date.now() + 5000
      while (!msg && Date.now() < deadline) {
        msg = received.find(m => m.type === 'TABLE_CREATED' && m.payload?.tableId === tableId)
        if (!msg) await new Promise(r => setTimeout(r, 50))
      }
      ws.removeListener('message', onMsg)

      assert.ok(msg, 'lobby subscriber should receive TABLE_CREATED for a public table')
      assert.equal(msg.payload.visibility, 'public')
      assert.equal(msg.payload.host, hostId)
      assert.ok(msg.payload.seats)

      await redis.hDel('lobby:tables', tableId)
      ws.terminate()
    })

    it('TABLE_UPDATED for a public table is broadcast on the lobby channel', { timeout: 15000 }, async () => {
      const { status, body } = await apiRequest(
        server.baseUrl, 'POST', '/api/tables',
        { name: 'Public Update Test' },
        { 'x-session-id': hostSession, 'x-player-id': hostId },
      )
      assert.equal(status, 201)
      const { tableId } = body
      keysToClean.push(`table:${tableId}`)

      const ws = await wsConnect(server, { 'x-session-id': friendSession })
      ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(ws, 'JOINED_LOBBY')

      const received = []
      const onMsg = (data) => received.push(JSON.parse(data.toString()))
      ws.on('message', onMsg)

      await apiRequest(
        server.baseUrl, 'POST', `/api/tables/${tableId}/sit`,
        { seat: 'east' },
        { 'x-session-id': friendSession, 'x-player-id': friendId },
      )

      let msg
      const deadline = Date.now() + 5000
      while (!msg && Date.now() < deadline) {
        msg = received.find(m => m.type === 'TABLE_UPDATED' && m.payload?.tableId === tableId)
        if (!msg) await new Promise(r => setTimeout(r, 50))
      }
      ws.removeListener('message', onMsg)

      assert.ok(msg, 'lobby subscriber should receive TABLE_UPDATED for a public table')
      assert.equal(msg.payload.visibility, 'public')

      await redis.hDel('lobby:tables', tableId)
      ws.terminate()
    })

    it('TABLE_REMOVED for a public table is broadcast on the lobby channel', { timeout: 15000 }, async () => {
      const { status, body } = await apiRequest(
        server.baseUrl, 'POST', '/api/tables',
        { name: 'Public Remove Test' },
        { 'x-session-id': hostSession, 'x-player-id': hostId },
      )
      assert.equal(status, 201)
      const { tableId } = body
      keysToClean.push(`table:${tableId}`)

      const ws = await wsConnect(server, { 'x-session-id': friendSession })
      ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(ws, 'JOINED_LOBBY')

      const received = []
      const onMsg = (data) => received.push(JSON.parse(data.toString()))
      ws.on('message', onMsg)

      await apiRequest(
        server.baseUrl, 'POST', `/api/tables/${tableId}/terminate`, null,
        { 'x-session-id': hostSession, 'x-player-id': hostId },
      )

      let msg
      const deadline = Date.now() + 5000
      while (!msg && Date.now() < deadline) {
        msg = received.find(m => m.type === 'TABLE_REMOVED' && m.payload?.tableId === tableId)
        if (!msg) await new Promise(r => setTimeout(r, 50))
      }
      ws.removeListener('message', onMsg)

      assert.ok(msg, 'lobby subscriber should receive TABLE_REMOVED for a public table')
      assert.equal(msg.payload.tableId, tableId)

      await redis.hDel('lobby:tables', tableId)
      ws.terminate()
    })
  })

  // ── Friends-Only tables → friend notify channels ─────────────────────────

  describe('Friends-Only tables notify host friends via player notify channels', () => {
    it('TABLE_CREATED for a friends-only table is sent to friend notify channel, not lobby', { timeout: 15000 }, async () => {
      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })
      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })

      wsFriend.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsFriend, 'JOINED_LOBBY')
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const tableId = `visroute-fo-create-${Date.now()}`
      const table = makeTable({
        tableId,
        hostPlayerId: hostId,
        name: 'Friends-Only Create',
        visibility: 'friends-only',
        joinPolicy: 'friends-only',
      })

      const lobbyEventsFriend = collectLobbyEvents(wsFriend, 800, tableId)
      const lobbyEventsStranger = collectLobbyEvents(wsStranger, 800, tableId)
      const friendNotify = collectAllMessages(wsFriend, 800, tableId)
      const strangerNotify = collectAllMessages(wsStranger, 800, tableId)

      await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
      keysToClean.push(`table:${tableId}`)

      if (server.wss.notifyPlayer) {
        server.wss.notifyPlayer(friendId, 'TABLE_CREATED', {
          tableId: table.tableId,
          name: table.name,
          host: table.hostPlayerId,
          seats: table.seats,
          visibility: table.visibility,
        })
      }

      const lobbyFriend = await lobbyEventsFriend
      const lobbyStranger = await lobbyEventsStranger

      assert.deepEqual(lobbyFriend, [], 'friends-only TABLE_CREATED must not appear on the public lobby channel (friend)')
      assert.deepEqual(lobbyStranger, [], 'friends-only TABLE_CREATED must not appear on the public lobby channel (stranger)')

      const friendMsgs = await friendNotify
      const strangerMsgs = await strangerNotify

      const friendCreated = friendMsgs.filter(m => m.type === 'TABLE_CREATED')
      const strangerCreated = strangerMsgs.filter(m => m.type === 'TABLE_CREATED')

      assert.ok(friendCreated.length > 0, 'host friend should receive TABLE_CREATED via notify channel')
      assert.equal(friendCreated[0].payload.visibility, 'friends-only')
      assert.equal(friendCreated[0].payload.host, hostId)
      assert.deepEqual(strangerCreated, [], 'non-friend should NOT receive TABLE_CREATED for a friends-only table')

      wsFriend.terminate()
      wsStranger.terminate()
    })

    it('TABLE_UPDATED for a friends-only table is sent to friend notify channel, not lobby', { timeout: 15000 }, async () => {
      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })
      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })

      wsFriend.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsFriend, 'JOINED_LOBBY')
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const tableId = `visroute-fo-update-${Date.now()}`
      const table = makeTable({
        tableId,
        hostPlayerId: hostId,
        name: 'Friends-Only Update',
        visibility: 'friends-only',
        joinPolicy: 'friends-only',
        seats: { north: hostId, east: null, south: null, west: null },
      })
      await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
      keysToClean.push(`table:${tableId}`)

      const lobbyEventsFriend = collectLobbyEvents(wsFriend, 800, tableId)
      const friendNotify = collectAllMessages(wsFriend, 800, tableId)
      const strangerNotify = collectAllMessages(wsStranger, 800, tableId)

      if (server.wss.notifyPlayer) {
        server.wss.notifyPlayer(friendId, 'TABLE_UPDATED', {
          tableId: table.tableId,
          name: table.name,
          host: table.hostPlayerId,
          seats: table.seats,
          status: table.status,
          visibility: table.visibility,
          observerCount: 0,
          spectating: false,
        })
      }

      const lobbyFriend = await lobbyEventsFriend
      assert.deepEqual(lobbyFriend, [], 'friends-only TABLE_UPDATED must not appear on the public lobby channel')

      const friendMsgs = await friendNotify
      const strangerMsgs = await strangerNotify

      const friendUpdated = friendMsgs.filter(m => m.type === 'TABLE_UPDATED')
      const strangerUpdated = strangerMsgs.filter(m => m.type === 'TABLE_UPDATED')

      assert.ok(friendUpdated.length > 0, 'host friend should receive TABLE_UPDATED via notify channel')
      assert.equal(friendUpdated[0].payload.visibility, 'friends-only')
      assert.deepEqual(strangerUpdated, [], 'non-friend should NOT receive TABLE_UPDATED for a friends-only table')

      wsFriend.terminate()
      wsStranger.terminate()
    })

    it('TABLE_REMOVED for a friends-only table is sent to friend notify channel, not lobby', { timeout: 15000 }, async () => {
      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })
      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })

      wsFriend.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsFriend, 'JOINED_LOBBY')
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const tableId = `visroute-fo-remove-${Date.now()}`
      const table = makeTable({
        tableId,
        hostPlayerId: hostId,
        name: 'Friends-Only Remove',
        visibility: 'friends-only',
        joinPolicy: 'friends-only',
      })
      await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
      keysToClean.push(`table:${tableId}`)

      const lobbyEventsFriend = collectLobbyEvents(wsFriend, 800, tableId)
      const friendNotify = collectAllMessages(wsFriend, 800, tableId)
      const strangerNotify = collectAllMessages(wsStranger, 800, tableId)

      if (server.wss.notifyPlayer) {
        server.wss.notifyPlayer(friendId, 'TABLE_REMOVED', {
          tableId: table.tableId,
        })
      }

      const lobbyFriend = await lobbyEventsFriend
      assert.deepEqual(lobbyFriend, [], 'friends-only TABLE_REMOVED must not appear on the public lobby channel')

      const friendMsgs = await friendNotify
      const strangerMsgs = await strangerNotify

      const friendRemoved = friendMsgs.filter(m => m.type === 'TABLE_REMOVED')
      const strangerRemoved = strangerMsgs.filter(m => m.type === 'TABLE_REMOVED')

      assert.ok(friendRemoved.length > 0, 'host friend should receive TABLE_REMOVED via notify channel')
      assert.equal(friendRemoved[0].payload.tableId, tableId)
      assert.deepEqual(strangerRemoved, [], 'non-friend should NOT receive TABLE_REMOVED for a friends-only table')

      wsFriend.terminate()
      wsStranger.terminate()
    })

    it('friends-only events reach multiple friends of the host', { timeout: 15000 }, async () => {
      const friend2Id = await insertTestPlayer(db, { email: 'friend2@visroute.test.spades.invalid', username: 'VisRouteFriend2' })
      await makeFriends(db, hostId, friend2Id)
      const friend2Session = await createSession(redis, { playerId: friend2Id, email: 'friend2@visroute.test.spades.invalid', username: 'VisRouteFriend2' })

      const wsFriend1 = await wsConnect(server, { 'x-session-id': friendSession })
      const wsFriend2 = await wsConnect(server, { 'x-session-id': friend2Session })

      const tableId = `visroute-fo-multi-${Date.now()}`
      const table = makeTable({
        tableId,
        hostPlayerId: hostId,
        name: 'Friends-Only Multi',
        visibility: 'friends-only',
        joinPolicy: 'friends-only',
      })
      await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
      keysToClean.push(`table:${tableId}`)

      const friend1Msgs = collectAllMessages(wsFriend1, 800, tableId)
      const friend2Msgs = collectAllMessages(wsFriend2, 800, tableId)

      if (server.wss.notifyPlayer) {
        server.wss.notifyPlayer(friendId, 'TABLE_CREATED', {
          tableId, name: table.name, host: hostId, seats: table.seats, visibility: 'friends-only',
        })
        server.wss.notifyPlayer(friend2Id, 'TABLE_CREATED', {
          tableId, name: table.name, host: hostId, seats: table.seats, visibility: 'friends-only',
        })
      }

      const f1 = await friend1Msgs
      const f2 = await friend2Msgs

      const f1Created = f1.filter(m => m.type === 'TABLE_CREATED')
      const f2Created = f2.filter(m => m.type === 'TABLE_CREATED')

      assert.ok(f1Created.length > 0, 'first friend should receive TABLE_CREATED')
      assert.ok(f2Created.length > 0, 'second friend should receive TABLE_CREATED')

      wsFriend1.terminate()
      wsFriend2.terminate()
      await redis.del(`session:${friend2Session}`)
    })
  })

  // ── Private tables → no broadcast ────────────────────────────────────────

  describe('Private tables generate no broadcast at all', () => {
    it('TABLE_CREATED for a private table produces no lobby or notify events', { timeout: 15000 }, async () => {
      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })
      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })

      wsFriend.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsFriend, 'JOINED_LOBBY')
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const tableId = `visroute-priv-create-${Date.now()}`
      const table = makeTable({
        tableId,
        hostPlayerId: hostId,
        name: 'Private Create',
        visibility: 'private',
        joinPolicy: 'invite-only',
      })
      await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
      keysToClean.push(`table:${tableId}`)

      const friendAll = collectAllMessages(wsFriend, 800, tableId)
      const strangerAll = collectAllMessages(wsStranger, 800, tableId)

      const friendMsgs = await friendAll
      const strangerMsgs = await strangerAll

      const friendTable = friendMsgs.filter(m => ['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'].includes(m.type))
      const strangerTable = strangerMsgs.filter(m => ['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'].includes(m.type))

      assert.deepEqual(friendTable, [], 'private table must not send events to friends')
      assert.deepEqual(strangerTable, [], 'private table must not send events to strangers')

      wsFriend.terminate()
      wsStranger.terminate()
    })

    it('TABLE_UPDATED for a private table produces no lobby or notify events', { timeout: 15000 }, async () => {
      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })

      wsFriend.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsFriend, 'JOINED_LOBBY')

      const tableId = `visroute-priv-update-${Date.now()}`
      const table = makeTable({
        tableId,
        hostPlayerId: hostId,
        name: 'Private Update',
        visibility: 'private',
        joinPolicy: 'invite-only',
        seats: { north: hostId, east: null, south: null, west: null },
      })
      await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
      keysToClean.push(`table:${tableId}`)

      const friendAll = collectAllMessages(wsFriend, 800, tableId)

      const friendMsgs = await friendAll
      const tableEvents = friendMsgs.filter(m => ['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'].includes(m.type))

      assert.deepEqual(tableEvents, [], 'private TABLE_UPDATED must not reach anyone — not even friends')

      wsFriend.terminate()
    })

    it('TABLE_REMOVED for a private table produces no lobby or notify events', { timeout: 15000 }, async () => {
      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })
      const wsStranger = await wsConnect(server, { 'x-session-id': strangerSession })

      wsFriend.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      wsStranger.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsFriend, 'JOINED_LOBBY')
      await waitForType(wsStranger, 'JOINED_LOBBY')

      const tableId = `visroute-priv-remove-${Date.now()}`
      const table = makeTable({
        tableId,
        hostPlayerId: hostId,
        name: 'Private Remove',
        visibility: 'private',
        joinPolicy: 'invite-only',
      })
      await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
      keysToClean.push(`table:${tableId}`)

      const friendAll = collectAllMessages(wsFriend, 800, tableId)
      const strangerAll = collectAllMessages(wsStranger, 800, tableId)

      const friendMsgs = await friendAll
      const strangerMsgs = await strangerAll

      const friendTable = friendMsgs.filter(m => ['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'].includes(m.type))
      const strangerTable = strangerMsgs.filter(m => ['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'].includes(m.type))

      assert.deepEqual(friendTable, [], 'private TABLE_REMOVED must not reach friends')
      assert.deepEqual(strangerTable, [], 'private TABLE_REMOVED must not reach strangers')

      wsFriend.terminate()
      wsStranger.terminate()
    })
  })

  // ── Cross-visibility isolation ───────────────────────────────────────────

  describe('Cross-visibility isolation', () => {
    it('friends-only event does not leak to the public lobby channel', { timeout: 15000 }, async () => {
      const wsLobby = await wsConnect(server, { 'x-session-id': strangerSession })
      wsLobby.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsLobby, 'JOINED_LOBBY')

      const tableId = `visroute-iso-fo-${Date.now()}`
      const table = makeTable({
        tableId,
        hostPlayerId: hostId,
        name: 'Isolation FO',
        visibility: 'friends-only',
        joinPolicy: 'friends-only',
      })
      await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
      keysToClean.push(`table:${tableId}`)

      const lobbyEvents = collectLobbyEvents(wsLobby, 800, tableId)

      if (server.wss.notifyPlayer) {
        server.wss.notifyPlayer(friendId, 'TABLE_CREATED', {
          tableId, name: table.name, host: hostId, seats: table.seats, visibility: 'friends-only',
        })
      }

      const received = await lobbyEvents
      assert.deepEqual(received, [], 'friends-only notification must never appear on the public lobby channel')

      wsLobby.terminate()
    })

    it('private table events do not reach any channel — lobby or notify', { timeout: 15000 }, async () => {
      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })
      const wsHost = await wsConnect(server, { 'x-session-id': hostSession })

      wsFriend.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      wsHost.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsFriend, 'JOINED_LOBBY')
      await waitForType(wsHost, 'JOINED_LOBBY')

      const tableId = `visroute-iso-priv-${Date.now()}`
      const table = makeTable({
        tableId,
        hostPlayerId: hostId,
        name: 'Isolation Private',
        visibility: 'private',
        joinPolicy: 'invite-only',
      })
      await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
      keysToClean.push(`table:${tableId}`)

      const friendAll = collectAllMessages(wsFriend, 800, tableId)
      const hostAll = collectAllMessages(wsHost, 800, tableId)

      const friendMsgs = await friendAll
      const hostMsgs = await hostAll

      const tableEventTypes = new Set(['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'])
      const friendTableEvents = friendMsgs.filter(m => tableEventTypes.has(m.type))
      const hostTableEvents = hostMsgs.filter(m => tableEventTypes.has(m.type))

      assert.deepEqual(friendTableEvents, [], 'private table must not notify friends')
      assert.deepEqual(hostTableEvents, [], 'private table must not notify even the host via broadcast')

      wsFriend.terminate()
      wsHost.terminate()
    })

    it('changing visibility from public to friends-only stops lobby broadcasts', { timeout: 15000 }, async () => {
      const wsLobby = await wsConnect(server, { 'x-session-id': strangerSession })
      wsLobby.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
      await waitForType(wsLobby, 'JOINED_LOBBY')

      const tableId = `visroute-vis-change-${Date.now()}`
      const table = makeTable({
        tableId,
        hostPlayerId: hostId,
        name: 'Vis Change Test',
        visibility: 'friends-only',
        joinPolicy: 'friends-only',
      })
      await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
      keysToClean.push(`table:${tableId}`)

      const lobbyEvents = collectLobbyEvents(wsLobby, 800, tableId)
      const received = await lobbyEvents

      assert.deepEqual(received, [], 'table changed to friends-only should not appear on public lobby channel')

      wsLobby.terminate()
    })
  })

  // ── Payload structure ────────────────────────────────────────────────────

  describe('Friends-only notification payload structure', () => {
    it('TABLE_CREATED notification includes required fields', { timeout: 15000 }, async () => {
      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })

      const tableId = `visroute-payload-${Date.now()}`
      const table = makeTable({
        tableId,
        hostPlayerId: hostId,
        name: 'Payload Test',
        visibility: 'friends-only',
        joinPolicy: 'friends-only',
      })

      const friendMsgs = collectAllMessages(wsFriend, 800, tableId)

      if (server.wss.notifyPlayer) {
        server.wss.notifyPlayer(friendId, 'TABLE_CREATED', {
          tableId: table.tableId,
          name: table.name,
          host: table.hostPlayerId,
          seats: table.seats,
          visibility: table.visibility,
        })
      }

      const msgs = await friendMsgs
      const created = msgs.find(m => m.type === 'TABLE_CREATED')

      assert.ok(created, 'friend should receive TABLE_CREATED')
      assert.equal(created.payload.tableId, tableId, 'payload must include tableId')
      assert.equal(created.payload.name, 'Payload Test', 'payload must include table name')
      assert.equal(created.payload.host, hostId, 'payload must include host player ID')
      assert.ok(created.payload.seats, 'payload must include seats')
      assert.equal(created.payload.visibility, 'friends-only', 'payload must include visibility')

      wsFriend.terminate()
    })

    it('TABLE_UPDATED notification includes status and observer info', { timeout: 15000 }, async () => {
      const wsFriend = await wsConnect(server, { 'x-session-id': friendSession })

      const tableId = `visroute-payload-upd-${Date.now()}`

      const friendMsgs = collectAllMessages(wsFriend, 800, tableId)

      if (server.wss.notifyPlayer) {
        server.wss.notifyPlayer(friendId, 'TABLE_UPDATED', {
          tableId,
          name: 'Updated Payload Test',
          host: hostId,
          seats: { north: hostId, east: friendId, south: null, west: null },
          status: 'waiting',
          visibility: 'friends-only',
          observerCount: 2,
          spectating: true,
        })
      }

      const msgs = await friendMsgs
      const updated = msgs.find(m => m.type === 'TABLE_UPDATED')

      assert.ok(updated, 'friend should receive TABLE_UPDATED')
      assert.equal(updated.payload.status, 'waiting', 'payload must include status')
      assert.equal(updated.payload.observerCount, 2, 'payload must include observerCount')
      assert.equal(updated.payload.spectating, true, 'payload must include spectating')

      wsFriend.terminate()
    })
  })
})
