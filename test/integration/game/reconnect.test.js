/**
 * Integration tests: disconnect/reconnect window and expired window behaviour (PRD Section 6.4.6).
 *
 * These tests exercise the full HTTP + WebSocket stack together and cover:
 *
 * Scenario 1 — Reconnect within window:
 * - Player disconnects mid-game
 * - Player reconnects within the 60 s (300 ms in test config) window
 * - GET /api/tables/:tableId/state returns the correct playing state (re-hydration):
 *   phase still 'playing', myHand present, no waitingForReconnect stall
 *
 * Scenario 2 — Expired reconnect window:
 * - Player disconnects mid-game
 * - 60 s window expires without reconnect
 * - GET /api/tables/:tableId/state exposes the waitingForReconnect indicator to other players
 * - POST /api/tables/:tableId/bid is rejected with 409 while the game is stalled
 * - POST /api/tables/:tableId/play is rejected with 409 while the game is stalled
 *
 * Tests run against a real Redis instance (no mocking per CLAUDE.md).
 * DATABASE_URL is not required: auth sessions are seeded directly into Redis.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import WebSocket from 'ws'
import { handler } from '../../../server/server.js'
import { createWsServer } from '../../../server/ws/index.js'
import { getRedis, closeRedis } from '../../../server/redis.js'
import { createGame } from '../../../server/game/state.js'

const skip = !process.env.REDIS_URL ? 'REDIS_URL must be set' : false

const TABLE_TTL = 3600

// ── WebSocket helpers ─────────────────────────────────────────────────────────

function wsConnect(server, headers = {}) {
  const { port } = server.address()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    ws.once('open', () => {
      setTimeout(() => resolve(ws), 100)
    })
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }))
    })
  })
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())))
    ws.once('error', reject)
  })
}

function waitClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    ws.once('close', () => resolve())
  })
}

/**
 * Collect messages until the given type arrives. Returns all collected messages.
 */
function waitForType(ws, targetType, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const msgs = []
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg)
      reject(new Error(`Timed out waiting for message type "${targetType}"`))
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

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Redis fixtures ────────────────────────────────────────────────────────────

function makeTable(tableId, seats) {
  return {
    tableId,
    hostPlayerId: Object.values(seats).find(Boolean),
    name: null,
    seats,
    status: 'playing',
    gameId: null,
    createdAt: new Date().toISOString(),
  }
}

async function seedFixture(redis, { tableId, northPlayerId, southPlayerId, northSessionId, southSessionId }) {
  const seats = {
    north: northPlayerId,
    east: 'bot:east',
    south: southPlayerId,
    west: 'bot:west',
  }
  const table = makeTable(tableId, seats)
  await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: TABLE_TTL })

  const initialState = createGame(tableId, seats)
  const gameState = {
    ...initialState,
    phase: 'playing',
    bids: { north: 3, east: 4, south: 3, west: 4 },
    teamBids: { ns: 3, ew: 4 },
    currentBidderSeat: null,
    currentPlayerSeat: 'north',
    leadSeat: 'north',
    isFirstTrick: true,
    spadesbroken: false,
    currentTrick: [],
  }
  await redis.set(`game:${tableId}`, JSON.stringify(gameState), { EX: TABLE_TTL })

  // Sessions seeded directly into Redis — no DB player records required
  await redis.set(`session:${northSessionId}`, JSON.stringify({ playerId: northPlayerId, username: 'North' }))
  await redis.set(`session:${southSessionId}`, JSON.stringify({ playerId: southPlayerId, username: 'South' }))
}

async function cleanupFixture(redis, { tableId, northSessionId, southSessionId }) {
  await redis.del(`table:${tableId}`)
  await redis.del(`game:${tableId}`)
  await redis.del(`session:${northSessionId}`)
  await redis.del(`session:${southSessionId}`)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Disconnect/reconnect integration: window and expiry behaviour', { skip }, () => {
  let httpServer, wss, redis, baseUrl

  before(async () => {
    redis = await getRedis()

    const app = express()
    app.use(express.json())
    httpServer = http.createServer(app)

    // Short reconnect window (300 ms) so timer-based tests don't need to wait 60 s.
    wss = createWsServer(httpServer, {
      redis,
      pingIntervalMs: 30_000,
      pongTimeoutMs: 10_000,
      reconnectWindowMs: 300,
    })
    await wss._subscriberReady

    // Register API routes on the same HTTP server.
    handler(app, { redis, wss })

    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const { port } = httpServer.address()
    baseUrl = `http://127.0.0.1:${port}`
  })

  after(async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => httpServer.close(resolve))
    await closeRedis()
  })

  // ── Scenario 1: Reconnect within window ──────────────────────────────────

  describe('Scenario 1 — reconnect within window', () => {
    it(
      'GET /state returns correct playing state after re-hydration (no stall, hand present)',
      { timeout: 15000 },
      async () => {
        const tableId = 'rcint-table-1'
        const northPlayerId = 'rcint-north-1'
        const southPlayerId = 'rcint-south-1'
        const northSessionId = 'rcint-ns-1'
        const southSessionId = 'rcint-ss-1'

        await seedFixture(redis, { tableId, northPlayerId, southPlayerId, northSessionId, southSessionId })

        // South player (observer) stays connected throughout
        const observer = await wsConnect(httpServer, { 'x-session-id': southSessionId })
        observer.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
        await nextMessage(observer) // JOINED

        // North player connects then disconnects
        const player = await wsConnect(httpServer, { 'x-session-id': northSessionId })
        player.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
        await nextMessage(player) // JOINED

        // Disconnect north — wait for PLAYER_DISCONNECTED on observer
        const disconnectP = waitForType(observer, 'PLAYER_DISCONNECTED')
        player.close()
        await waitClose(player)
        await disconnectP

        // Reconnect within the window
        const playerBack = await wsConnect(httpServer, { 'x-session-id': northSessionId })
        playerBack.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
        await nextMessage(playerBack) // JOINED

        // Allow any asynchronous Redis updates to settle
        await delay(50)

        // Re-hydration: GET /api/tables/:tableId/state should return the intact playing state
        const stateRes = await fetch(`${baseUrl}/api/tables/${tableId}/state`, {
          headers: {
            'x-session-id': northSessionId,
            'x-player-id': northPlayerId,
          },
        })
        assert.equal(stateRes.status, 200, 'State endpoint should return 200 after reconnect')
        const state = await stateRes.json()

        assert.equal(state.phase, 'playing', 'Game phase should still be playing')
        assert.ok(!state.waitingForReconnect, 'Game should not be stalled — reconnect was within window')
        assert.ok(Array.isArray(state.myHand) && state.myHand.length > 0, 'Reconnected player should receive their hand in re-hydration')

        playerBack.close()
        observer.close()
        await Promise.all([waitClose(playerBack), waitClose(observer)])
        await cleanupFixture(redis, { tableId, northSessionId, southSessionId })
      },
    )
  })

  // ── Scenario 2: Expired reconnect window ─────────────────────────────────

  describe('Scenario 2 — expired reconnect window', () => {
    it(
      'GET /state exposes waitingForReconnect indicator to other players after window expires',
      { timeout: 15000 },
      async () => {
        const tableId = 'rcint-table-2'
        const northPlayerId = 'rcint-north-2'
        const southPlayerId = 'rcint-south-2'
        const northSessionId = 'rcint-ns-2'
        const southSessionId = 'rcint-ss-2'

        await seedFixture(redis, { tableId, northPlayerId, southPlayerId, northSessionId, southSessionId })

        // South player (observer) stays connected
        const observer = await wsConnect(httpServer, { 'x-session-id': southSessionId })
        observer.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
        await nextMessage(observer) // JOINED

        // North player connects then disconnects
        const player = await wsConnect(httpServer, { 'x-session-id': northSessionId })
        player.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
        await nextMessage(player) // JOINED

        const disconnectP = waitForType(observer, 'PLAYER_DISCONNECTED')
        player.close()
        await waitClose(player)
        await disconnectP

        // Wait for reconnect window to expire (300 ms + buffer)
        await delay(800)

        // South player calls GET /state — should see the waitingForReconnect stall indicator
        const stateRes = await fetch(`${baseUrl}/api/tables/${tableId}/state`, {
          headers: {
            'x-session-id': southSessionId,
            'x-player-id': southPlayerId,
          },
        })
        assert.equal(stateRes.status, 200, 'State endpoint should return 200 for observer')
        const state = await stateRes.json()

        assert.ok(state.waitingForReconnect, 'State should include waitingForReconnect indicator after window expires')
        assert.equal(
          state.waitingForReconnect.seat,
          'north',
          'waitingForReconnect should identify the disconnected north seat',
        )

        observer.close()
        await waitClose(observer)
        await cleanupFixture(redis, { tableId, northSessionId, southSessionId })
      },
    )

    it(
      'POST /bid is rejected with 409 when game is stalled waiting for reconnect',
      { timeout: 15000 },
      async () => {
        const tableId = 'rcint-table-3'
        const northPlayerId = 'rcint-north-3'
        const southPlayerId = 'rcint-south-3'
        const northSessionId = 'rcint-ns-3'
        const southSessionId = 'rcint-ss-3'

        await seedFixture(redis, { tableId, northPlayerId, southPlayerId, northSessionId, southSessionId })

        // North disconnects while south observes (south must be in the room to receive broadcast)
        const observer = await wsConnect(httpServer, { 'x-session-id': southSessionId })
        observer.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
        await nextMessage(observer) // JOINED

        const player = await wsConnect(httpServer, { 'x-session-id': northSessionId })
        player.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
        await nextMessage(player) // JOINED

        const disconnectP = waitForType(observer, 'PLAYER_DISCONNECTED')
        player.close()
        await waitClose(player)
        await disconnectP

        // Wait for reconnect window to expire and waitingForReconnect to be written to Redis
        await delay(800)

        // POST /bid while stalled — waitingForReconnect check fires first (before bid turn validation)
        const bidRes = await fetch(`${baseUrl}/api/tables/${tableId}/bid`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-session-id': southSessionId,
            'x-player-id': southPlayerId,
          },
          body: JSON.stringify({ bid: 3 }),
        })
        assert.equal(bidRes.status, 409, 'POST /bid should be rejected with 409 while game is stalled')
        const body = await bidRes.json()
        assert.ok(body.error, 'Response should include an error message')

        observer.close()
        await waitClose(observer)
        await cleanupFixture(redis, { tableId, northSessionId, southSessionId })
      },
    )

    it(
      'POST /play is rejected with 409 when game is stalled waiting for reconnect',
      { timeout: 15000 },
      async () => {
        const tableId = 'rcint-table-4'
        const northPlayerId = 'rcint-north-4'
        const southPlayerId = 'rcint-south-4'
        const northSessionId = 'rcint-ns-4'
        const southSessionId = 'rcint-ss-4'

        await seedFixture(redis, { tableId, northPlayerId, southPlayerId, northSessionId, southSessionId })

        // North disconnects while south observes
        const observer = await wsConnect(httpServer, { 'x-session-id': southSessionId })
        observer.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
        await nextMessage(observer) // JOINED

        const player = await wsConnect(httpServer, { 'x-session-id': northSessionId })
        player.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
        await nextMessage(player) // JOINED

        const disconnectP = waitForType(observer, 'PLAYER_DISCONNECTED')
        player.close()
        await waitClose(player)
        await disconnectP

        // Wait for reconnect window to expire
        await delay(800)

        // POST /play while stalled — waitingForReconnect check fires before card validation
        // North is currentPlayerSeat but is stalled; south would also be blocked
        const playRes = await fetch(`${baseUrl}/api/tables/${tableId}/play`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-session-id': northSessionId,
            'x-player-id': northPlayerId,
          },
          body: JSON.stringify({ card: { suit: 'spades', rank: '2' } }),
        })
        assert.equal(playRes.status, 409, 'POST /play should be rejected with 409 while game is stalled')
        const body = await playRes.json()
        assert.ok(body.error, 'Response should include an error message')

        observer.close()
        await waitClose(observer)
        await cleanupFixture(redis, { tableId, northSessionId, southSessionId })
      },
    )
  })
})
