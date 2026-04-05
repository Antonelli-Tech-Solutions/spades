/**
 * Integration tests: lobby WebSocket events are emitted for Public tables.
 *
 * Verifies that TABLE_CREATED, TABLE_UPDATED, and TABLE_REMOVED events are
 * broadcast to the lobby channel when public table state changes via the API.
 * Only public tables should emit to the lobby channel.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import WebSocket from 'ws'
import { handler } from '../../server/server.js'
import { createWsServer } from '../../server/ws/index.js'
import { getRedis, closeRedis } from '../../server/redis.js'

const skip = !process.env.REDIS_URL ? 'REDIS_URL must be set' : false

// ── Helpers ───────────────────────────────────────────────────────────────────

function wsConnect(server, headers = {}) {
  const { port } = server.httpServer.address()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }))
    })
  })
}

function waitClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    ws.once('close', () => resolve())
  })
}

/**
 * Collect messages until one of the given types arrives. Returns all collected messages up to and
 * including the matching one, or rejects on timeout.
 */
function waitForType(ws, targetType, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const msgs = []
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg)
      reject(new Error(`Timed out waiting for message type "${targetType}" (got: ${msgs.map((m) => m.type).join(', ')})`))
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

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Lobby WebSocket events for Public tables', { skip }, () => {
  let server, redis

  // Player A is the host/observer; Player B is a sitter
  const SESSION_A = 'lobby-evt-session-a'
  const PLAYER_A = 'lobby-evt-player-a'
  const SESSION_B = 'lobby-evt-session-b'
  const PLAYER_B = 'lobby-evt-player-b'

  before(async () => {
    redis = await getRedis()

    // Seed two player sessions directly in Redis
    await redis.set(`session:${SESSION_A}`, JSON.stringify({ playerId: PLAYER_A, username: 'LobbyEvtHostA' }))
    await redis.set(`session:${SESSION_B}`, JSON.stringify({ playerId: PLAYER_B, username: 'LobbyEvtPlayerB' }))

    server = await startTestServer(redis)
  })

  after(async () => {
    await server.close()

    await redis.del(`session:${SESSION_A}`)
    await redis.del(`session:${SESSION_B}`)

    await closeRedis()
  })

  it('TABLE_CREATED is emitted to the lobby channel when a Public table is created', { timeout: 15000 }, async () => {
    const ws = await wsConnect(server, { 'x-session-id': SESSION_A })

    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await waitForType(ws, 'JOINED_LOBBY')

    const msgPromise = waitForType(ws, 'TABLE_CREATED')

    const { status, body } = await apiRequest(
      server.baseUrl,
      'POST',
      '/api/tables',
      { name: 'Test Lobby Table' },
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )
    assert.equal(status, 201, 'table creation should succeed')
    const { tableId } = body

    const [msg] = await msgPromise
    assert.equal(msg.type, 'TABLE_CREATED')
    assert.equal(msg.payload.tableId, tableId)
    assert.equal(msg.payload.visibility, 'public')
    assert.equal(msg.payload.host, PLAYER_A)
    assert.ok(msg.payload.seats, 'payload should include seats')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)

    ws.close()
    await waitClose(ws)
  })

  it('TABLE_UPDATED is emitted to the lobby channel when a player sits at a Public table', { timeout: 15000 }, async () => {
    // Create a table first (no WS listener — just use the API)
    const createRes = await apiRequest(
      server.baseUrl,
      'POST',
      '/api/tables',
      { name: 'Sit Test Table' },
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )
    assert.equal(createRes.status, 201)
    const { tableId } = createRes.body

    // Connect WS subscriber to the lobby
    const ws = await wsConnect(server, { 'x-session-id': SESSION_B })
    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await waitForType(ws, 'JOINED_LOBBY')

    const msgPromise = waitForType(ws, 'TABLE_UPDATED')

    await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/sit`,
      { seat: 'north' },
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )

    const [msg] = await msgPromise
    assert.equal(msg.type, 'TABLE_UPDATED')
    assert.equal(msg.payload.tableId, tableId)
    assert.equal(msg.payload.visibility, 'public')
    assert.ok(msg.payload.seats, 'payload should include updated seats')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)

    ws.close()
    await waitClose(ws)
  })

  it('TABLE_REMOVED is emitted to the lobby channel when a Public table is terminated', { timeout: 15000 }, async () => {
    // Create and seed a table to terminate
    const createRes = await apiRequest(
      server.baseUrl,
      'POST',
      '/api/tables',
      { name: 'Terminate Test Table' },
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )
    assert.equal(createRes.status, 201)
    const { tableId } = createRes.body

    // Sit in north so the player is the host and can terminate
    await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/sit`,
      { seat: 'north' },
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )

    // Subscribe to lobby
    const ws = await wsConnect(server, { 'x-session-id': SESSION_B })
    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await waitForType(ws, 'JOINED_LOBBY')

    const msgPromise = waitForType(ws, 'TABLE_REMOVED')

    const { status } = await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/terminate`,
      null,
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )
    assert.equal(status, 200)

    const [msg] = await msgPromise
    assert.equal(msg.type, 'TABLE_REMOVED')
    assert.equal(msg.payload.tableId, tableId)

    ws.close()
    await waitClose(ws)
  })

  it('TABLE_UPDATED includes updated seat state after a player sits', { timeout: 15000 }, async () => {
    const createRes = await apiRequest(
      server.baseUrl,
      'POST',
      '/api/tables',
      null,
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )
    const { tableId } = createRes.body

    const ws = await wsConnect(server, { 'x-session-id': SESSION_A })
    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await waitForType(ws, 'JOINED_LOBBY')

    const msgPromise = waitForType(ws, 'TABLE_UPDATED')

    await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/sit`,
      { seat: 'west' },
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )

    const [msg] = await msgPromise
    assert.equal(msg.payload.seats.west, PLAYER_A, 'west seat should be occupied by PLAYER_A')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)

    ws.close()
    await waitClose(ws)
  })

  it('TABLE_REMOVED is emitted when last human leaves an in-progress game (table auto-terminates)', { timeout: 15000 }, async () => {
    // Seed a table directly in Redis with all-bot seats (so player leaving terminates it)
    const tableId = 'lobby-evt-terminate-test'
    const table = {
      tableId,
      hostPlayerId: PLAYER_A,
      name: 'Auto-terminate test',
      seats: { north: PLAYER_A, east: 'bot:east', south: 'bot:south', west: 'bot:west' },
      status: 'playing',
      gameId: 'fake-game',
      createdAt: new Date().toISOString(),
      visibility: 'public',
    }
    await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
    await redis.hSet('lobby:tables', tableId, JSON.stringify({ tableId, hostPlayerId: PLAYER_A, status: 'playing' }))
    // Seed minimal game state so the leave endpoint doesn't error on getGameState
    await redis.set(`game:${tableId}`, JSON.stringify({ phase: 'playing', tableId, gameId: 'fake-game' }), { EX: 3600 })

    const ws = await wsConnect(server, { 'x-session-id': SESSION_B })
    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await waitForType(ws, 'JOINED_LOBBY')

    const msgPromise = waitForType(ws, 'TABLE_REMOVED')

    await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/leave`,
      null,
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )

    const [msg] = await msgPromise
    assert.equal(msg.type, 'TABLE_REMOVED')
    assert.equal(msg.payload.tableId, tableId)

    ws.close()
    await waitClose(ws)
  })
})

// ── Visibility enforcement ────────────────────────────────────────────────────

/**
 * Collect all messages received on the WebSocket within the given window.
 * Used to assert that NO lobby events are emitted for non-public tables.
 */
function collectFor(ws, durationMs) {
  return new Promise((resolve) => {
    const msgs = []
    function onMsg(data) { msgs.push(JSON.parse(data.toString())) }
    ws.on('message', onMsg)
    setTimeout(() => {
      ws.removeListener('message', onMsg)
      resolve(msgs)
    }, durationMs)
  })
}

describe('Visibility enforcement — Friends-Only and Private tables do NOT emit to lobby channel', { skip }, () => {
  let server, redis

  const SESSION_VIS = 'lobby-vis-session-a'
  const PLAYER_VIS = 'lobby-vis-player-a'

  before(async () => {
    redis = await getRedis()
    await redis.set(`session:${SESSION_VIS}`, JSON.stringify({ playerId: PLAYER_VIS, username: 'LobbyVisA' }))
    server = await startTestServer(redis)
  })

  after(async () => {
    await server.close()
    await redis.del(`session:${SESSION_VIS}`)
    await closeRedis()
  })

  // ── Friends-Only ────────────────────────────────────────────────────────────

  it('TABLE_UPDATED is NOT emitted to lobby when a player sits at a Friends-Only table', { timeout: 10000 }, async () => {
    const tableId = 'lobby-vis-fo-sit'
    const table = {
      tableId,
      hostPlayerId: PLAYER_VIS,
      name: 'Friends-Only Sit Test',
      seats: { north: null, east: null, south: null, west: null },
      status: 'waiting',
      gameId: null,
      createdAt: new Date().toISOString(),
      visibility: 'friends-only',
    }
    await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
    await redis.hSet('lobby:tables', tableId, JSON.stringify({ tableId, hostPlayerId: PLAYER_VIS, status: 'waiting' }))

    const ws = await wsConnect(server, { 'x-session-id': SESSION_VIS })
    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await waitForType(ws, 'JOINED_LOBBY')

    // Begin collecting before the sit action fires
    const collectPromise = collectFor(ws, 500)

    await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/sit`,
      { seat: 'north' },
      { 'x-session-id': SESSION_VIS, 'x-player-id': PLAYER_VIS },
    )

    const msgs = await collectPromise
    const lobbyTableMsgs = msgs.filter((m) => ['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'].includes(m.type))
    assert.equal(lobbyTableMsgs.length, 0, `Expected no lobby table events for friends-only table, got: ${lobbyTableMsgs.map((m) => m.type).join(', ')}`)

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)

    ws.close()
    await waitClose(ws)
  })

  it('TABLE_REMOVED is NOT emitted to lobby when a Friends-Only table is terminated', { timeout: 10000 }, async () => {
    const tableId = 'lobby-vis-fo-terminate'
    const table = {
      tableId,
      hostPlayerId: PLAYER_VIS,
      name: 'Friends-Only Terminate Test',
      seats: { north: PLAYER_VIS, east: null, south: null, west: null },
      status: 'waiting',
      gameId: null,
      createdAt: new Date().toISOString(),
      visibility: 'friends-only',
    }
    await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
    await redis.hSet('lobby:tables', tableId, JSON.stringify({ tableId, hostPlayerId: PLAYER_VIS, status: 'waiting' }))

    const ws = await wsConnect(server, { 'x-session-id': SESSION_VIS })
    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await waitForType(ws, 'JOINED_LOBBY')

    const collectPromise = collectFor(ws, 500)

    const { status } = await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/terminate`,
      null,
      { 'x-session-id': SESSION_VIS, 'x-player-id': PLAYER_VIS },
    )
    assert.equal(status, 200)

    const msgs = await collectPromise
    const lobbyTableMsgs = msgs.filter((m) => ['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'].includes(m.type))
    assert.equal(lobbyTableMsgs.length, 0, `Expected no lobby table events for friends-only table, got: ${lobbyTableMsgs.map((m) => m.type).join(', ')}`)

    ws.close()
    await waitClose(ws)
  })

  it('TABLE_UPDATED is NOT emitted to lobby when the host leaves a Friends-Only waiting table', { timeout: 10000 }, async () => {
    const tableId = 'lobby-vis-fo-leave'
    const table = {
      tableId,
      hostPlayerId: PLAYER_VIS,
      name: 'Friends-Only Leave Test',
      seats: { north: PLAYER_VIS, east: null, south: null, west: null },
      status: 'waiting',
      gameId: null,
      createdAt: new Date().toISOString(),
      visibility: 'friends-only',
    }
    await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
    await redis.hSet('lobby:tables', tableId, JSON.stringify({ tableId, hostPlayerId: PLAYER_VIS, status: 'waiting' }))

    const ws = await wsConnect(server, { 'x-session-id': SESSION_VIS })
    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await waitForType(ws, 'JOINED_LOBBY')

    const collectPromise = collectFor(ws, 500)

    await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/leave`,
      null,
      { 'x-session-id': SESSION_VIS, 'x-player-id': PLAYER_VIS },
    )

    const msgs = await collectPromise
    const lobbyTableMsgs = msgs.filter((m) => ['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'].includes(m.type))
    assert.equal(lobbyTableMsgs.length, 0, `Expected no lobby table events for friends-only table, got: ${lobbyTableMsgs.map((m) => m.type).join(', ')}`)

    // Cleanup remaining table state (leave doesn't terminate for waiting tables)
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)

    ws.close()
    await waitClose(ws)
  })

  // ── Private ──────────────────────────────────────────────────────────────────

  it('TABLE_UPDATED is NOT emitted to lobby when a player sits at a Private table', { timeout: 10000 }, async () => {
    const tableId = 'lobby-vis-priv-sit'
    const table = {
      tableId,
      hostPlayerId: PLAYER_VIS,
      name: 'Private Sit Test',
      seats: { north: null, east: null, south: null, west: null },
      status: 'waiting',
      gameId: null,
      createdAt: new Date().toISOString(),
      visibility: 'private',
    }
    await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
    await redis.hSet('lobby:tables', tableId, JSON.stringify({ tableId, hostPlayerId: PLAYER_VIS, status: 'waiting' }))

    const ws = await wsConnect(server, { 'x-session-id': SESSION_VIS })
    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await waitForType(ws, 'JOINED_LOBBY')

    const collectPromise = collectFor(ws, 500)

    await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/sit`,
      { seat: 'north' },
      { 'x-session-id': SESSION_VIS, 'x-player-id': PLAYER_VIS },
    )

    const msgs = await collectPromise
    const lobbyTableMsgs = msgs.filter((m) => ['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'].includes(m.type))
    assert.equal(lobbyTableMsgs.length, 0, `Expected no lobby table events for private table, got: ${lobbyTableMsgs.map((m) => m.type).join(', ')}`)

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)

    ws.close()
    await waitClose(ws)
  })

  it('TABLE_REMOVED is NOT emitted to lobby when a Private table is terminated', { timeout: 10000 }, async () => {
    const tableId = 'lobby-vis-priv-terminate'
    const table = {
      tableId,
      hostPlayerId: PLAYER_VIS,
      name: 'Private Terminate Test',
      seats: { north: PLAYER_VIS, east: null, south: null, west: null },
      status: 'waiting',
      gameId: null,
      createdAt: new Date().toISOString(),
      visibility: 'private',
    }
    await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
    await redis.hSet('lobby:tables', tableId, JSON.stringify({ tableId, hostPlayerId: PLAYER_VIS, status: 'waiting' }))

    const ws = await wsConnect(server, { 'x-session-id': SESSION_VIS })
    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await waitForType(ws, 'JOINED_LOBBY')

    const collectPromise = collectFor(ws, 500)

    const { status } = await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/terminate`,
      null,
      { 'x-session-id': SESSION_VIS, 'x-player-id': PLAYER_VIS },
    )
    assert.equal(status, 200)

    const msgs = await collectPromise
    const lobbyTableMsgs = msgs.filter((m) => ['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'].includes(m.type))
    assert.equal(lobbyTableMsgs.length, 0, `Expected no lobby table events for private table, got: ${lobbyTableMsgs.map((m) => m.type).join(', ')}`)

    ws.close()
    await waitClose(ws)
  })

  it('TABLE_UPDATED is NOT emitted to lobby when the host leaves a Private waiting table', { timeout: 10000 }, async () => {
    const tableId = 'lobby-vis-priv-leave'
    const table = {
      tableId,
      hostPlayerId: PLAYER_VIS,
      name: 'Private Leave Test',
      seats: { north: PLAYER_VIS, east: null, south: null, west: null },
      status: 'waiting',
      gameId: null,
      createdAt: new Date().toISOString(),
      visibility: 'private',
    }
    await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
    await redis.hSet('lobby:tables', tableId, JSON.stringify({ tableId, hostPlayerId: PLAYER_VIS, status: 'waiting' }))

    const ws = await wsConnect(server, { 'x-session-id': SESSION_VIS })
    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await waitForType(ws, 'JOINED_LOBBY')

    const collectPromise = collectFor(ws, 500)

    await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/leave`,
      null,
      { 'x-session-id': SESSION_VIS, 'x-player-id': PLAYER_VIS },
    )

    const msgs = await collectPromise
    const lobbyTableMsgs = msgs.filter((m) => ['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REMOVED'].includes(m.type))
    assert.equal(lobbyTableMsgs.length, 0, `Expected no lobby table events for private table, got: ${lobbyTableMsgs.map((m) => m.type).join(', ')}`)

    // Cleanup remaining table state
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)

    ws.close()
    await waitClose(ws)
  })
})
