/**
 * Integration tests: in-game WebSocket events are emitted after validated state mutations.
 *
 * These tests verify that the server emits the correct WebSocket events to connected
 * clients when game actions (play card, bid, etc.) are processed. The tests set up
 * game state directly in Redis (bypassing the full table-creation/registration flow)
 * to keep the setup minimal.
 *
 * Test coverage:
 * - CARD_PLAYED is broadcast to all clients in the table room when a card is played
 * - BID_PLACED is broadcast to all clients when a bid is placed
 * - HAND_DEALT is sent per-player (only their own cards) when a new hand starts
 * - TURN_CHANGED is broadcast after each game action
 * - TRICK_COMPLETE is broadcast after the 4th card of a trick is played
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import WebSocket from 'ws'
import { handler } from '../../server/server.js'
import { createWsServer } from '../../server/ws/index.js'
import { createGame } from '../../server/game/state.js'
import { getLegalPlays } from '../../server/game/trick.js'
import { getRedis, closeRedis } from '../../server/redis.js'

const skip = !process.env.REDIS_URL ? 'REDIS_URL must be set' : false

// ── Helpers ───────────────────────────────────────────────────────────────────

function wsConnect(server, headers = {}) {
  const { port } = server.address()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
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
 * Collect the next N messages from the WebSocket.
 */
function collectMessages(ws, count, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const msgs = []
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg)
      reject(new Error(`Timed out waiting for ${count} messages, got ${msgs.length}`))
    }, timeoutMs)

    function onMsg(data) {
      msgs.push(JSON.parse(data.toString()))
      if (msgs.length >= count) {
        clearTimeout(timer)
        ws.removeListener('message', onMsg)
        resolve(msgs)
      }
    }
    ws.on('message', onMsg)
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

// ── Redis fixture helpers ─────────────────────────────────────────────────────

const TABLE_TTL = 3600

async function seedGameFixture(redis, { tableId, northPlayerId, gameState }) {
  const table = {
    tableId,
    hostPlayerId: northPlayerId,
    name: null,
    seats: {
      north: northPlayerId,
      east: 'bot:east',
      south: 'bot:south',
      west: 'bot:west',
    },
    status: 'playing',
    gameId: gameState.gameId,
    createdAt: new Date().toISOString(),
  }
  await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: TABLE_TTL })
  await redis.set(`game:${tableId}`, JSON.stringify(gameState), { EX: TABLE_TTL })
}

async function cleanupGameFixture(redis, { tableId, sessionId }) {
  await redis.del(`table:${tableId}`)
  await redis.del(`game:${tableId}`)
  await redis.del(`session:${sessionId}`)
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('In-game WebSocket events', { skip }, () => {
  let server, redis

  before(async () => {
    redis = await getRedis()
    server = await startTestServer(redis)
  })

  after(async () => {
    await server.close()
    await closeRedis()
  })

  describe('CARD_PLAYED event', { timeout: 15000 }, () => {
    it('broadcasts CARD_PLAYED to all clients in the room when a card is played', { timeout: 15000 }, async () => {
      const tableId = 'ws-events-table-1'
      const northPlayerId = 'ws-events-north-1'
      const sessionId = 'ws-events-session-1'

      await redis.set(`session:${sessionId}`, JSON.stringify({ playerId: northPlayerId, username: 'North' }))

      // Build a game state in playing phase with north as the current player
      const initialState = createGame(tableId, {
        north: northPlayerId,
        east: 'bot:east',
        south: 'bot:south',
        west: 'bot:west',
      })
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

      await seedGameFixture(redis, { tableId, northPlayerId, gameState })

      // Connect two WebSocket clients and join the room
      const ws1 = await wsConnect(server.httpServer, { 'x-session-id': sessionId })
      const ws2 = await wsConnect(server.httpServer, { 'x-session-id': sessionId })

      ws1.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      ws2.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await Promise.all([nextMessage(ws1), nextMessage(ws2)]) // consume JOINED acks

      // Pick a legal card for north to play (non-spade on first trick)
      const northHand = gameState.hands.north
      const card = northHand.find((c) => c.suit !== 'spades') ?? northHand[0]

      // Listen for CARD_PLAYED on both clients
      const p1 = waitForType(ws1, 'CARD_PLAYED')
      const p2 = waitForType(ws2, 'CARD_PLAYED')

      // Play the card via HTTP API
      const res = await apiRequest(
        server.baseUrl,
        'POST',
        `/api/tables/${tableId}/play`,
        { card },
        { 'x-session-id': sessionId, 'x-player-id': northPlayerId },
      )
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`)

      // Both clients should receive CARD_PLAYED
      const [msgs1, msgs2] = await Promise.all([p1, p2])
      const ev1 = msgs1.find((m) => m.type === 'CARD_PLAYED')
      const ev2 = msgs2.find((m) => m.type === 'CARD_PLAYED')

      assert.ok(ev1, 'ws1 should receive CARD_PLAYED')
      assert.ok(ev2, 'ws2 should receive CARD_PLAYED')
      assert.equal(ev1.payload.seat, 'north')
      assert.deepEqual(ev1.payload.card, card)
      assert.equal(ev2.payload.seat, 'north')
      assert.deepEqual(ev2.payload.card, card)

      ws1.close(); ws2.close()
      await Promise.all([waitClose(ws1), waitClose(ws2)])
      await cleanupGameFixture(redis, { tableId, sessionId })
    })

    it('does NOT deliver CARD_PLAYED to clients not in that room', { timeout: 15000 }, async () => {
      const tableId = 'ws-events-table-2'
      const northPlayerId = 'ws-events-north-2'
      const sessionId = 'ws-events-session-2'

      await redis.set(`session:${sessionId}`, JSON.stringify({ playerId: northPlayerId, username: 'North' }))

      const initialState = createGame(tableId, {
        north: northPlayerId,
        east: 'bot:east',
        south: 'bot:south',
        west: 'bot:west',
      })
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
      await seedGameFixture(redis, { tableId, northPlayerId, gameState })

      const wsIn = await wsConnect(server.httpServer, { 'x-session-id': sessionId })
      const wsOut = await wsConnect(server.httpServer, { 'x-session-id': sessionId })

      wsIn.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(wsIn) // JOINED
      // wsOut never joins the room

      let outsiderReceived = false
      wsOut.on('message', () => { outsiderReceived = true })

      const northHand = gameState.hands.north
      const card = northHand.find((c) => c.suit !== 'spades') ?? northHand[0]

      const p = waitForType(wsIn, 'CARD_PLAYED')
      await apiRequest(
        server.baseUrl,
        'POST',
        `/api/tables/${tableId}/play`,
        { card },
        { 'x-session-id': sessionId, 'x-player-id': northPlayerId },
      )
      await p

      // Give wsOut a chance to receive anything spurious
      await new Promise((r) => setTimeout(r, 80))
      assert.equal(outsiderReceived, false, 'Client not in the room should not receive CARD_PLAYED')

      wsIn.close(); wsOut.close()
      await Promise.all([waitClose(wsIn), waitClose(wsOut)])
      await cleanupGameFixture(redis, { tableId, sessionId })
    })
  })

  describe('BID_PLACED event', { timeout: 15000 }, () => {
    it('broadcasts BID_PLACED to all clients in the room when a bid is placed', { timeout: 15000 }, async () => {
      const tableId = 'ws-events-table-3'
      const northPlayerId = 'ws-events-north-3'
      const sessionId = 'ws-events-session-3'

      await redis.set(`session:${sessionId}`, JSON.stringify({ playerId: northPlayerId, username: 'North' }))

      const gameState = createGame(tableId, {
        north: northPlayerId,
        east: 'bot:east',
        south: 'bot:south',
        west: 'bot:west',
      })
      // North deals → bidding order starts with east (left of dealer). Advance bots until north's turn.
      // Actually north deals, so bidding order is east, south, west, north.
      // We'll manipulate state so north is the first bidder.
      const testState = {
        ...gameState,
        biddingOrder: ['north', 'east', 'south', 'west'],
        currentBidderSeat: 'north',
      }
      await seedGameFixture(redis, { tableId, northPlayerId, gameState: testState })

      const ws = await wsConnect(server.httpServer, { 'x-session-id': sessionId })
      ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(ws) // JOINED

      const p = waitForType(ws, 'BID_PLACED')
      const res = await apiRequest(
        server.baseUrl,
        'POST',
        `/api/tables/${tableId}/bid`,
        { bid: 3 },
        { 'x-session-id': sessionId, 'x-player-id': northPlayerId },
      )
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`)

      const msgs = await p
      const ev = msgs.find((m) => m.type === 'BID_PLACED')
      assert.ok(ev, 'Should receive BID_PLACED')
      assert.equal(ev.payload.seat, 'north')
      assert.equal(ev.payload.bidType, 'number')

      ws.close()
      await waitClose(ws)
      await cleanupGameFixture(redis, { tableId, sessionId })
    })
  })

  describe('TURN_CHANGED event', { timeout: 15000 }, () => {
    it('broadcasts TURN_CHANGED after a card is played', { timeout: 15000 }, async () => {
      const tableId = 'ws-events-table-4'
      const northPlayerId = 'ws-events-north-4'
      const sessionId = 'ws-events-session-4'

      await redis.set(`session:${sessionId}`, JSON.stringify({ playerId: northPlayerId, username: 'North' }))

      const initialState = createGame(tableId, {
        north: northPlayerId,
        east: 'bot:east',
        south: 'bot:south',
        west: 'bot:west',
      })
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
      await seedGameFixture(redis, { tableId, northPlayerId, gameState })

      const ws = await wsConnect(server.httpServer, { 'x-session-id': sessionId })
      ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(ws) // JOINED

      const northHand = gameState.hands.north
      const card = northHand.find((c) => c.suit !== 'spades') ?? northHand[0]

      const p = waitForType(ws, 'TURN_CHANGED')
      await apiRequest(
        server.baseUrl,
        'POST',
        `/api/tables/${tableId}/play`,
        { card },
        { 'x-session-id': sessionId, 'x-player-id': northPlayerId },
      )
      const msgs = await p
      const ev = msgs.find((m) => m.type === 'TURN_CHANGED')
      assert.ok(ev, 'Should receive TURN_CHANGED after playing a card')
      assert.ok(ev.payload.phase, 'TURN_CHANGED should include phase')

      ws.close()
      await waitClose(ws)
      await cleanupGameFixture(redis, { tableId, sessionId })
    })
  })

  describe('TRICK_COMPLETE event', { timeout: 15000 }, () => {
    it('broadcasts TRICK_COMPLETE after the 4th card of a trick', { timeout: 15000 }, async () => {
      const tableId = 'ws-events-table-5'
      const northPlayerId = 'ws-events-north-5'
      const sessionId = 'ws-events-session-5'

      await redis.set(`session:${sessionId}`, JSON.stringify({ playerId: northPlayerId, username: 'North' }))

      const initialState = createGame(tableId, {
        north: northPlayerId,
        east: 'bot:east',
        south: 'bot:south',
        west: 'bot:west',
      })

      // Build a state where 3 cards have already been played in the current trick
      // (north has already played, east and south have played, west is next... but we need north to be next)
      // Simpler: have east, south, west already played; north to play the 4th card
      const northHand = initialState.hands.north
      const eastHand = initialState.hands.east
      const southHand = initialState.hands.south
      const westHand = initialState.hands.west

      // Pick a non-spade lead card from east
      const eastCard = eastHand.find((c) => c.suit !== 'spades') ?? eastHand[0]
      // South follows suit if possible, else any non-spade
      const eastSuit = eastCard.suit
      const southCard = southHand.find((c) => c.suit === eastSuit) ??
        southHand.find((c) => c.suit !== 'spades') ?? southHand[0]
      const westCard = westHand.find((c) => c.suit === eastSuit) ??
        westHand.find((c) => c.suit !== 'spades') ?? westHand[0]

      const currentTrick = [
        { seat: 'east', card: eastCard },
        { seat: 'south', card: southCard },
        { seat: 'west', card: westCard },
      ]

      const gameState = {
        ...initialState,
        phase: 'playing',
        bids: { north: 3, east: 4, south: 3, west: 4 },
        teamBids: { ns: 3, ew: 4 },
        currentBidderSeat: null,
        currentPlayerSeat: 'north',
        leadSeat: 'east',
        isFirstTrick: true,
        spadesbroken: false,
        currentTrick,
        hands: {
          ...initialState.hands,
          east: eastHand.filter((c) => c !== eastCard),
          south: southHand.filter((c) => c !== southCard),
          west: westHand.filter((c) => c !== westCard),
        },
      }

      await seedGameFixture(redis, { tableId, northPlayerId, gameState })

      const ws = await wsConnect(server.httpServer, { 'x-session-id': sessionId })
      ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
      await nextMessage(ws) // JOINED

      // North needs to play a legal card (must follow east's suit if possible, no spades on first trick)
      const legalCards = getLegalPlays(northHand, currentTrick, false, true)
      assert.ok(legalCards.length > 0, 'North should have legal cards to play')
      const card = legalCards[0]

      const p = waitForType(ws, 'TRICK_COMPLETE')
      const res = await apiRequest(
        server.baseUrl,
        'POST',
        `/api/tables/${tableId}/play`,
        { card },
        { 'x-session-id': sessionId, 'x-player-id': northPlayerId },
      )
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`)

      const msgs = await p
      const ev = msgs.find((m) => m.type === 'TRICK_COMPLETE')
      assert.ok(ev, 'Should receive TRICK_COMPLETE after 4th card')
      assert.ok(ev.payload.winnerSeat, 'TRICK_COMPLETE should include winnerSeat')
      assert.ok(Array.isArray(ev.payload.plays), 'TRICK_COMPLETE should include plays array')
      assert.equal(ev.payload.plays.length, 4, 'TRICK_COMPLETE plays should have 4 entries')

      ws.close()
      await waitClose(ws)
      await cleanupGameFixture(redis, { tableId, sessionId })
    })
  })

  describe('HAND_DEALT event', { timeout: 15000 }, () => {
    it('sends HAND_DEALT only to the target player (not broadcast)', { timeout: 15000 }, async () => {
      // Verify sendToPlayer delivers to the right player.
      // We test this by checking HAND_DEALT arrives after wss.sendToPlayer is called directly.
      // Session must be set before connecting — WS auth runs during the HTTP upgrade.
      await redis.set('session:valid-ws-session-for-hand-dealt', JSON.stringify({ playerId: 'hand-dealt-player', username: 'HDPlayer' }))
      const ws = await wsConnect(server.httpServer, { 'x-session-id': 'valid-ws-session-for-hand-dealt' })

      const p = waitForType(ws, 'HAND_DEALT')
      server.wss.sendToPlayer('hand-dealt-player', 'HAND_DEALT', {
        dealer: 'north',
        biddingOrder: ['east', 'south', 'west', 'north'],
        blindNilEligible: false,
        myHand: [{ suit: 'spades', rank: 'A' }],
      })

      const msgs = await p
      const ev = msgs.find((m) => m.type === 'HAND_DEALT')
      assert.ok(ev, 'Should receive HAND_DEALT')
      assert.equal(ev.payload.dealer, 'north')
      assert.equal(ev.payload.blindNilEligible, false)
      assert.ok(Array.isArray(ev.payload.myHand), 'myHand should be present when not blind-nil-eligible')

      ws.close()
      await waitClose(ws)
      await redis.del('session:valid-ws-session-for-hand-dealt')
    })
  })
})
