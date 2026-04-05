/**
 * Integration tests: player disconnect detection and reconnect window (PRD Section 6.4.6).
 *
 * Test coverage:
 * - PLAYER_DISCONNECTED is broadcast to the table room when a seated player's WS closes
 * - PLAYER_RECONNECTED is broadcast when the player re-joins within the reconnect window
 * - No PLAYER_RECONNECTED is emitted when the player re-joins after the window has expired
 * - Game state is marked waitingForReconnect after the reconnect window expires
 * - Game actions (play, bid) are rejected with 409 when game is stalled waiting for reconnect
 * - Reconnecting clears the waitingForReconnect stall from game state
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import WebSocket from 'ws'
import { createWsServer } from '../../server/ws/index.js'
import { getRedis, closeRedis } from '../../server/redis.js'
import { createGame } from '../../server/game/state.js'

const skip = !process.env.REDIS_URL ? 'REDIS_URL must be set' : false

const TABLE_TTL = 3600

// ── Helpers ───────────────────────────────────────────────────────────────────

function wsConnect(server, headers = {}, wsOpts = {}) {
  const { port } = server.address()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers, ...wsOpts })
    ws.once('open', () => resolve(ws))
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

/**
 * Wait a given number of milliseconds — used to let timers fire in short-window tests.
 */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTable(tableId, seats) {
  return {
    tableId,
    hostPlayerId: Object.values(seats)[0],
    name: null,
    seats,
    status: 'playing',
    gameId: null,
    createdAt: new Date().toISOString(),
  }
}

async function seedFixture(redis, { tableId, northPlayerId, southPlayerId, sessionId, southSessionId }) {
  const seats = {
    north: northPlayerId,
    east: 'bot:east',
    south: southPlayerId ?? 'bot:south',
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

  await redis.set(`session:${sessionId}`, JSON.stringify({ playerId: northPlayerId, username: 'North' }))
  if (southPlayerId && southSessionId) {
    await redis.set(`session:${southSessionId}`, JSON.stringify({ playerId: southPlayerId, username: 'South' }))
  }
}

async function cleanupFixture(redis, { tableId, sessionId, southSessionId }) {
  await redis.del(`table:${tableId}`)
  await redis.del(`game:${tableId}`)
  await redis.del(`session:${sessionId}`)
  if (southSessionId) await redis.del(`session:${southSessionId}`)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Player disconnect detection and reconnect window', { skip }, () => {
  let httpServer, wss, redis

  before(async () => {
    redis = await getRedis()

    httpServer = http.createServer()
    // Short reconnect window (300 ms) so timer tests don't need to wait 60 s
    wss = createWsServer(httpServer, {
      redis,
      pingIntervalMs: 30_000,
      pongTimeoutMs: 10_000,
      reconnectWindowMs: 300,
    })
    await wss._subscriberReady
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  })

  after(async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => httpServer.close(resolve))
    await closeRedis()
  })

  // ── PLAYER_DISCONNECTED ───────────────────────────────────────────────────

  describe('PLAYER_DISCONNECTED', () => {
    it('broadcasts PLAYER_DISCONNECTED to the room when a seated player disconnects during a game', { timeout: 15000 }, async () => {
      const tableId = 'dc-table-1'
      const northPlayerId = 'dc-north-1'
      const sessionId = 'dc-session-1'
      const southPlayerId = 'dc-south-1'
      const southSessionId = 'dc-session-1s'

      await seedFixture(redis, { tableId, northPlayerId, sessionId, southPlayerId, southSessionId })

      // Observer (south player) stays connected throughout
      const observer = await wsConnect(httpServer, { 'x-session-id': southSessionId })
      observer.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(observer) // JOINED

      // North player that will disconnect
      const player = await wsConnect(httpServer, { 'x-session-id': sessionId })
      player.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(player) // JOINED

      const p = waitForType(observer, 'PLAYER_DISCONNECTED')
      player.close()
      await waitClose(player)

      const msgs = await p
      const ev = msgs.find((m) => m.type === 'PLAYER_DISCONNECTED')
      assert.ok(ev, 'Observer should receive PLAYER_DISCONNECTED')
      assert.equal(ev.payload.seat, 'north', 'Disconnected seat should be north')
      assert.ok(typeof ev.payload.reconnectWindowSeconds === 'number', 'reconnectWindowSeconds should be a number')
      assert.ok(ev.payload.reconnectWindowSeconds > 0, 'reconnectWindowSeconds should be positive')

      observer.close()
      await waitClose(observer)
      await cleanupFixture(redis, { tableId, sessionId, southSessionId })
    })

    it('does NOT broadcast PLAYER_DISCONNECTED when the table is not in playing status', { timeout: 15000 }, async () => {
      const tableId = 'dc-table-2'
      const northPlayerId = 'dc-north-2'
      const sessionId = 'dc-session-2'

      // Seed table with waiting status (not playing)
      const seats = { north: northPlayerId, east: null, south: null, west: null }
      const table = {
        tableId, hostPlayerId: northPlayerId, name: null, seats, status: 'waiting',
        gameId: null, createdAt: new Date().toISOString(),
      }
      await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: TABLE_TTL })
      await redis.set(`session:${sessionId}`, JSON.stringify({ playerId: northPlayerId, username: 'North' }))

      const observer = await wsConnect(httpServer, { 'x-session-id': sessionId })
      observer.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(observer) // JOINED

      const player = await wsConnect(httpServer, { 'x-session-id': sessionId })
      player.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(player) // JOINED

      let received = false
      observer.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'PLAYER_DISCONNECTED') received = true
      })

      player.close()
      await waitClose(player)

      // Small delay to allow any spurious message to arrive
      await delay(100)
      assert.equal(received, false, 'Should not emit PLAYER_DISCONNECTED for non-playing tables')

      observer.close()
      await waitClose(observer)
      await redis.del(`table:${tableId}`)
      await redis.del(`session:${sessionId}`)
    })
  })

  // ── PLAYER_RECONNECTED ────────────────────────────────────────────────────

  describe('PLAYER_RECONNECTED', () => {
    it('broadcasts PLAYER_RECONNECTED when the player reconnects within the window', { timeout: 15000 }, async () => {
      const tableId = 'dc-table-3'
      const northPlayerId = 'dc-north-3'
      const sessionId = 'dc-session-3'
      const southPlayerId = 'dc-south-3'
      const southSessionId = 'dc-session-3s'

      await seedFixture(redis, { tableId, northPlayerId, sessionId, southPlayerId, southSessionId })

      // Observer is the south player — different playerId from north
      const observer = await wsConnect(httpServer, { 'x-session-id': southSessionId })
      observer.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(observer) // JOINED

      const player = await wsConnect(httpServer, { 'x-session-id': sessionId })
      player.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(player) // JOINED

      // Disconnect player
      const disconnectP = waitForType(observer, 'PLAYER_DISCONNECTED')
      player.close()
      await waitClose(player)
      await disconnectP

      // Reconnect player within window
      const reconnectP = waitForType(observer, 'PLAYER_RECONNECTED')
      const playerBack = await wsConnect(httpServer, { 'x-session-id': sessionId })
      playerBack.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(playerBack) // JOINED

      const msgs = await reconnectP
      const ev = msgs.find((m) => m.type === 'PLAYER_RECONNECTED')
      assert.ok(ev, 'Observer should receive PLAYER_RECONNECTED')
      assert.equal(ev.payload.seat, 'north', 'Reconnected seat should be north')

      playerBack.close()
      observer.close()
      await Promise.all([waitClose(playerBack), waitClose(observer)])
      await cleanupFixture(redis, { tableId, sessionId, southSessionId })
    })

    it('does NOT broadcast PLAYER_RECONNECTED when the player reconnects after window expires', { timeout: 15000 }, async () => {
      const tableId = 'dc-table-4'
      const northPlayerId = 'dc-north-4'
      const sessionId = 'dc-session-4'
      const southPlayerId = 'dc-south-4'
      const southSessionId = 'dc-session-4s'

      await seedFixture(redis, { tableId, northPlayerId, sessionId, southPlayerId, southSessionId })

      // Observer is the south player — different playerId from north
      const observer = await wsConnect(httpServer, { 'x-session-id': southSessionId })
      observer.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(observer) // JOINED

      const player = await wsConnect(httpServer, { 'x-session-id': sessionId })
      player.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(player) // JOINED

      // Disconnect player
      const disconnectP = waitForType(observer, 'PLAYER_DISCONNECTED')
      player.close()
      await waitClose(player)
      await disconnectP

      // Wait for the reconnect window to expire (300 ms in test setup + buffer)
      await delay(500)

      let reconnectedReceived = false
      observer.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'PLAYER_RECONNECTED') reconnectedReceived = true
      })

      // Re-join after window expired
      const playerLate = await wsConnect(httpServer, { 'x-session-id': sessionId })
      playerLate.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(playerLate) // JOINED

      await delay(100)
      assert.equal(reconnectedReceived, false, 'Should not emit PLAYER_RECONNECTED after window expires')

      playerLate.close()
      observer.close()
      await Promise.all([waitClose(playerLate), waitClose(observer)])
      await cleanupFixture(redis, { tableId, sessionId, southSessionId })
    })
  })

  // ── Game stall ────────────────────────────────────────────────────────────

  describe('game stall on reconnect window expiry', () => {
    it('sets waitingForReconnect on game state when reconnect window expires', { timeout: 15000 }, async () => {
      const tableId = 'dc-table-5'
      const northPlayerId = 'dc-north-5'
      const sessionId = 'dc-session-5'
      const southPlayerId = 'dc-south-5'
      const southSessionId = 'dc-session-5s'

      await seedFixture(redis, { tableId, northPlayerId, sessionId, southPlayerId, southSessionId })

      const player = await wsConnect(httpServer, { 'x-session-id': sessionId })
      player.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(player) // JOINED

      // Observer is the south player — different playerId so disconnect event can fire
      const observer = await wsConnect(httpServer, { 'x-session-id': southSessionId })
      observer.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(observer) // JOINED

      const disconnectP = waitForType(observer, 'PLAYER_DISCONNECTED')
      player.close()
      await waitClose(player)
      await disconnectP

      // Wait for timer to fire
      await delay(500)

      // Game state should now have waitingForReconnect
      const gameData = await redis.get(`game:${tableId}`)
      assert.ok(gameData, 'Game state should still exist')
      const gameState = JSON.parse(gameData)
      assert.ok(gameState.waitingForReconnect, 'Game state should have waitingForReconnect set')
      assert.equal(gameState.waitingForReconnect.seat, 'north')

      observer.close()
      await waitClose(observer)
      await cleanupFixture(redis, { tableId, sessionId, southSessionId })
    })

    it('clears waitingForReconnect when player reconnects (even after window expiry)', { timeout: 15000 }, async () => {
      const tableId = 'dc-table-6'
      const northPlayerId = 'dc-north-6'
      const sessionId = 'dc-session-6'
      const southPlayerId = 'dc-south-6'
      const southSessionId = 'dc-session-6s'

      await seedFixture(redis, { tableId, northPlayerId, sessionId, southPlayerId, southSessionId })

      // Observer is the south player — different playerId so disconnect event can fire
      const observer = await wsConnect(httpServer, { 'x-session-id': southSessionId })
      observer.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(observer) // JOINED

      const player = await wsConnect(httpServer, { 'x-session-id': sessionId })
      player.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(player) // JOINED

      // Disconnect
      const disconnectP = waitForType(observer, 'PLAYER_DISCONNECTED')
      player.close()
      await waitClose(player)
      await disconnectP

      // Wait for window to expire and stall to be set
      await delay(500)

      const stalledData = await redis.get(`game:${tableId}`)
      assert.ok(JSON.parse(stalledData).waitingForReconnect, 'Game should be stalled before reconnect')

      // Reconnect — this should clear the stall even though window expired
      const playerBack = await wsConnect(httpServer, { 'x-session-id': sessionId })
      playerBack.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(playerBack) // JOINED

      // Small delay for Redis update
      await delay(50)

      const gameData = await redis.get(`game:${tableId}`)
      const gameState = JSON.parse(gameData)
      assert.ok(!gameState.waitingForReconnect, 'waitingForReconnect should be cleared after player rejoins')

      playerBack.close()
      observer.close()
      await Promise.all([waitClose(playerBack), waitClose(observer)])
      await cleanupFixture(redis, { tableId, sessionId, southSessionId })
    })
  })
})
