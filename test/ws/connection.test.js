import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import WebSocket from 'ws'
import { createWsServer } from '../../server/ws/index.js'

// --- Minimal fake Redis -----------------------------------------------------------
function makeFakeRedis(sessions = {}) {
  return {
    get: async (key) => {
      const sessionId = key.replace(/^session:/, '')
      return sessions[sessionId] ? JSON.stringify(sessions[sessionId]) : null
    },
    set: async () => 'OK',
    del: async () => 1,
  }
}

// --- Helpers ---------------------------------------------------------------------
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
    if (ws.readyState === WebSocket.CLOSED) return resolve(ws._closeCode ?? ws.closeCode)
    ws.once('close', (code) => resolve(code))
  })
}

// ----- Test suite ----------------------------------------------------------------
describe('WebSocket server', () => {
  let httpServer, wss, redis

  before(async () => {
    redis = makeFakeRedis({
      'valid-session-1': { playerId: 'player-1', username: 'Alice' },
    })
    httpServer = http.createServer()
    wss = createWsServer(httpServer, {
      redis,
      pingIntervalMs: 150,
      pongTimeoutMs: 100,
    })
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  })

  after(async () => {
    wss.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })

  // ── Authentication ──────────────────────────────────────────────────────────

  describe('authentication', () => {
    it('rejects upgrade when x-session-id header is missing', async () => {
      const err = await wsConnect(httpServer).then(
        () => { throw new Error('expected rejection') },
        (e) => e,
      )
      assert.ok(err.statusCode === 401 || err.message.includes('401'), `got: ${err.message}`)
    })

    it('rejects upgrade when x-session-id is invalid', async () => {
      const err = await wsConnect(httpServer, { 'x-session-id': 'bad-session' }).then(
        () => { throw new Error('expected rejection') },
        (e) => e,
      )
      assert.ok(err.statusCode === 401 || err.message.includes('401'), `got: ${err.message}`)
    })

    it('accepts upgrade with a valid x-session-id', async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })
      assert.equal(ws.readyState, WebSocket.OPEN)
      ws.close()
      await waitClose(ws)
    })
  })

  // ── Room management ─────────────────────────────────────────────────────────

  describe('room management', () => {
    it('sends JOINED ack when client sends JOIN with a tableId', async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })

      ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'table-abc' } }))
      const msg = await nextMessage(ws)

      assert.equal(msg.type, 'JOINED')
      assert.equal(msg.payload.tableId, 'table-abc')

      ws.close()
      await waitClose(ws)
    })

    it('sends LEFT ack when client sends LEAVE', async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })

      ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'table-xyz' } }))
      await nextMessage(ws) // consume JOINED

      ws.send(JSON.stringify({ type: 'LEAVE', payload: { tableId: 'table-xyz' } }))
      const msg = await nextMessage(ws)

      assert.equal(msg.type, 'LEFT')
      assert.equal(msg.payload.tableId, 'table-xyz')

      ws.close()
      await waitClose(ws)
    })

    it('broadcast() delivers an event to all clients in a table room', async () => {
      const ws1 = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })
      const ws2 = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })

      ws1.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'table-bcast' } }))
      ws2.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'table-bcast' } }))
      await nextMessage(ws1) // JOINED
      await nextMessage(ws2) // JOINED

      const p1 = nextMessage(ws1)
      const p2 = nextMessage(ws2)
      wss.broadcast('table-bcast', 'CARD_PLAYED', { seat: 'north', card: { suit: 'spades', rank: 'A' } })

      const [m1, m2] = await Promise.all([p1, p2])
      assert.equal(m1.type, 'CARD_PLAYED')
      assert.equal(m2.type, 'CARD_PLAYED')

      ws1.close(); ws2.close()
      await Promise.all([waitClose(ws1), waitClose(ws2)])
    })

    it('broadcast() does NOT deliver to clients not in that room', async () => {
      const wsIn = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })
      const wsOut = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })

      wsIn.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'table-in' } }))
      await nextMessage(wsIn) // JOINED
      // wsOut never joins any room

      let outsiderReceived = false
      wsOut.on('message', () => { outsiderReceived = true })

      wss.broadcast('table-in', 'CARD_PLAYED', { seat: 'east', card: { suit: 'hearts', rank: '2' } })

      // Give time for any spurious delivery
      await new Promise((r) => setTimeout(r, 80))
      assert.equal(outsiderReceived, false)

      wsIn.close(); wsOut.close()
      await Promise.all([waitClose(wsIn), waitClose(wsOut)])
    })

    it('sendToPlayer() delivers only to the target player', async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })

      const msgPromise = nextMessage(ws)
      wss.sendToPlayer('player-1', 'HAND_DEALT', { cards: [] })
      const msg = await msgPromise

      assert.equal(msg.type, 'HAND_DEALT')

      ws.close()
      await waitClose(ws)
    })
  })

  // ── Heartbeat ───────────────────────────────────────────────────────────────

  describe('heartbeat', () => {
    it('server sends a ping to connected clients', async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })

      const pingReceived = await new Promise((resolve) => {
        ws.once('ping', () => resolve(true))
        setTimeout(() => resolve(false), 400)
      })

      assert.ok(pingReceived, 'expected a ping within 400 ms')
      ws.close()
      await waitClose(ws)
    })

    it('server terminates connection when pong is not received within pongTimeoutMs', async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })

      // Disable automatic pong response
      ws.on('ping', () => { /* do nothing */ })

      const code = await waitClose(ws)
      // Any close is fine — terminated connections may emit code 1006 or similar
      assert.ok(code !== undefined, 'connection should be closed after pong timeout')
    })
  })
})
