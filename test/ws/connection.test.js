import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import WebSocket from 'ws'
import { createWsServer } from '../../server/ws/index.js'
import { getRedis, closeRedis } from '../../server/redis.js'

const skip = !process.env.REDIS_URL ? 'REDIS_URL must be set' : false

function makeTableJson(tableId, seatedPlayerIds = []) {
  const seatNames = ['north', 'east', 'south', 'west']
  const seats = { north: null, east: null, south: null, west: null }
  seatedPlayerIds.forEach((id, i) => {
    if (seatNames[i]) seats[seatNames[i]] = id
  })
  return JSON.stringify({
    tableId,
    seats,
    status: 'waiting',
    hostPlayerId: seatedPlayerIds[0] || null,
    name: null,
    gameId: null,
    createdAt: new Date().toISOString(),
  })
}

// --- Helpers ---------------------------------------------------------------------
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
    if (ws.readyState === WebSocket.CLOSED) return resolve(ws._closeCode ?? ws.closeCode)
    ws.once('close', (code) => resolve(code))
  })
}

// ----- Test suite ----------------------------------------------------------------
describe('WebSocket server', { skip }, () => {
  let httpServer, wss, redis

  before(async () => {
    redis = await getRedis()

    await redis.set('session:valid-session-1', JSON.stringify({ playerId: 'player-1', username: 'Alice' }))
    await redis.set('table:table-abc',   makeTableJson('table-abc',   ['player-1']))
    await redis.set('table:table-xyz',   makeTableJson('table-xyz',   ['player-1']))
    await redis.set('table:table-bcast', makeTableJson('table-bcast', ['player-1']))
    await redis.set('table:table-in',    makeTableJson('table-in',    ['player-1']))

    httpServer = http.createServer()
    wss = createWsServer(httpServer, {
      redis,
      pingIntervalMs: 150,
      pongTimeoutMs: 100,
    })
    await wss._subscriberReady
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  })

  after(async () => {
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => httpServer.close(resolve))

    await redis.del('session:valid-session-1')
    await redis.del('table:table-abc')
    await redis.del('table:table-xyz')
    await redis.del('table:table-bcast')
    await redis.del('table:table-in')

    await closeRedis()
  })

  // ── Authentication ──────────────────────────────────────────────────────────

  describe('authentication', { timeout: 15000 }, () => {
    it('rejects upgrade when x-session-id header is missing', { timeout: 15000 }, async () => {
      const err = await wsConnect(httpServer).then(
        () => { throw new Error('expected rejection') },
        (e) => e,
      )
      assert.ok(err.statusCode === 401 || err.message.includes('401'), `got: ${err.message}`)
    })

    it('rejects upgrade when x-session-id is invalid', { timeout: 15000 }, async () => {
      const err = await wsConnect(httpServer, { 'x-session-id': 'bad-session' }).then(
        () => { throw new Error('expected rejection') },
        (e) => e,
      )
      assert.ok(err.statusCode === 401 || err.message.includes('401'), `got: ${err.message}`)
    })

    it('accepts upgrade with a valid x-session-id', { timeout: 15000 }, async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })
      assert.equal(ws.readyState, WebSocket.OPEN)
      ws.close()
      await waitClose(ws)
    })
  })

  // ── Room management ─────────────────────────────────────────────────────────

  describe('room management', { timeout: 15000 }, () => {
    it('sends JOINED ack when client sends JOIN with a tableId', { timeout: 15000 }, async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })

      ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'table-abc' } }))
      const msg = await nextMessage(ws)

      assert.equal(msg.type, 'JOINED')
      assert.equal(msg.payload.tableId, 'table-abc')

      ws.close()
      await waitClose(ws)
    })

    it('sends LEFT ack when client sends LEAVE', { timeout: 15000 }, async () => {
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

    it('broadcast() delivers an event to all clients in a table room', { timeout: 15000 }, async () => {
      const ws1 = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })
      const ws2 = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })

      ws1.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'table-bcast' } }))
      ws2.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'table-bcast' } }))
      await Promise.all([nextMessage(ws1), nextMessage(ws2)]) // both JOINED

      const p1 = nextMessage(ws1)
      const p2 = nextMessage(ws2)
      wss.broadcast('table-bcast', 'CARD_PLAYED', { seat: 'north', card: { suit: 'spades', rank: 'A' } })

      const [m1, m2] = await Promise.all([p1, p2])
      assert.equal(m1.type, 'CARD_PLAYED')
      assert.equal(m2.type, 'CARD_PLAYED')

      ws1.close(); ws2.close()
      await Promise.all([waitClose(ws1), waitClose(ws2)])
    })

    it('broadcast() does NOT deliver to clients not in that room', { timeout: 15000 }, async () => {
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

    it('sendToPlayer() delivers only to the target player', { timeout: 15000 }, async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })

      const msgPromise = nextMessage(ws)
      wss.sendToPlayer('player-1', 'HAND_DEALT', { cards: [] })
      const msg = await msgPromise

      assert.equal(msg.type, 'HAND_DEALT')

      ws.close()
      await waitClose(ws)
    })
  })

  // ── JOIN authorization ──────────────────────────────────────────────────────

  describe('JOIN authorization', { timeout: 15000 }, () => {
    let httpServer2, wss2

    before(async () => {
      await redis.set('session:session-p1', JSON.stringify({ playerId: 'player-1', username: 'Alice' }))
      await redis.set('session:session-p2', JSON.stringify({ playerId: 'player-2', username: 'Bob' }))
      await redis.set('table:table-private', makeTableJson('table-private', ['player-1']))

      httpServer2 = http.createServer()
      wss2 = createWsServer(httpServer2, { redis, pingIntervalMs: 30_000, pongTimeoutMs: 10_000 })
      await wss2._subscriberReady
      await new Promise((resolve) => httpServer2.listen(0, '127.0.0.1', resolve))
    })

    after(async () => {
      await new Promise((resolve) => wss2.close(resolve))
      await new Promise((resolve) => httpServer2.close(resolve))

      await redis.del('session:session-p1')
      await redis.del('session:session-p2')
      await redis.del('table:table-private')
    })

    it('sends JOIN_DENIED when player is not seated at the table', { timeout: 15000 }, async () => {
      const ws = await wsConnect(httpServer2, { 'x-session-id': 'session-p2' })
      ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'table-private' } }))
      const msg = await nextMessage(ws)
      assert.equal(msg.type, 'JOIN_DENIED')
      assert.equal(msg.payload.tableId, 'table-private')
      ws.close()
      await waitClose(ws)
    })

    it('sends JOIN_DENIED when table does not exist in Redis', { timeout: 15000 }, async () => {
      const ws = await wsConnect(httpServer2, { 'x-session-id': 'session-p1' })
      ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'nonexistent-table' } }))
      const msg = await nextMessage(ws)
      assert.equal(msg.type, 'JOIN_DENIED')
      assert.equal(msg.payload.tableId, 'nonexistent-table')
      ws.close()
      await waitClose(ws)
    })

    it('sends JOINED when player is seated at the table', { timeout: 15000 }, async () => {
      const ws = await wsConnect(httpServer2, { 'x-session-id': 'session-p1' })
      ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'table-private' } }))
      const msg = await nextMessage(ws)
      assert.equal(msg.type, 'JOINED')
      assert.equal(msg.payload.tableId, 'table-private')
      ws.close()
      await waitClose(ws)
    })
  })

  // ── Heartbeat ───────────────────────────────────────────────────────────────

  describe('heartbeat', { timeout: 15000 }, () => {
    it('server sends a ping to connected clients', { timeout: 15000 }, async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' })

      const pingReceived = await new Promise((resolve) => {
        ws.once('ping', () => resolve(true))
        setTimeout(() => resolve(false), 400)
      })

      assert.ok(pingReceived, 'expected a ping within 400 ms')
      ws.close()
      await waitClose(ws)
    })

    it('server terminates connection when pong is not received within pongTimeoutMs', { timeout: 15000 }, async () => {
      // autoPong: false prevents the ws library from automatically replying to pings
      const ws = await wsConnect(httpServer, { 'x-session-id': 'valid-session-1' }, { autoPong: false })

      const code = await waitClose(ws)
      // Any close is fine — terminated connections may emit code 1006 or similar
      assert.ok(code !== undefined, 'connection should be closed after pong timeout')
    })
  })
})
