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

// ----- Test suite ----------------------------------------------------------------

describe('WebSocket Redis pub/sub fan-out', { skip }, () => {
  let httpServer1, wss1
  let httpServer2, wss2
  let redis

  before(async () => {
    redis = await getRedis()

    await redis.set('session:pubsub-s1', JSON.stringify({ playerId: 'pubsub-p1', username: 'PubSubUser1' }))
    await redis.set('session:pubsub-s2', JSON.stringify({ playerId: 'pubsub-p2', username: 'PubSubUser2' }))
    await redis.set('table:fanout-table', makeTableJson('fanout-table', ['pubsub-p1', 'pubsub-p2']))

    // Server instance 1
    httpServer1 = http.createServer()
    wss1 = createWsServer(httpServer1, { redis })
    await wss1._subscriberReady
    await new Promise((resolve) => httpServer1.listen(0, '127.0.0.1', resolve))

    // Server instance 2 (simulates a separate server process sharing the same Redis)
    httpServer2 = http.createServer()
    wss2 = createWsServer(httpServer2, { redis })
    await wss2._subscriberReady
    await new Promise((resolve) => httpServer2.listen(0, '127.0.0.1', resolve))
  })

  after(async () => {
    await Promise.all([
      new Promise((resolve) => wss1.close(resolve)),
      new Promise((resolve) => wss2.close(resolve)),
    ])
    await Promise.all([
      new Promise((resolve) => httpServer1.close(resolve)),
      new Promise((resolve) => httpServer2.close(resolve)),
    ])

    await redis.del('session:pubsub-s1')
    await redis.del('session:pubsub-s2')
    await redis.del('table:fanout-table')

    await closeRedis()
  })

  // ── Table room pub/sub fan-out ─────────────────────────────────────────────

  it('broadcast() on instance 2 delivers to client on instance 1 via Redis pub/sub', async () => {
    const ws = await wsConnect(httpServer1, { 'x-session-id': 'pubsub-s1' })

    ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'fanout-table' } }))
    const joined = await nextMessage(ws)
    assert.equal(joined.type, 'JOINED')

    const msgPromise = nextMessage(ws)
    wss2.broadcast('fanout-table', 'CARD_PLAYED', { seat: 'north', card: { suit: 'spades', rank: 'A' } })
    const msg = await msgPromise

    assert.equal(msg.type, 'CARD_PLAYED')
    assert.deepEqual(msg.payload, { seat: 'north', card: { suit: 'spades', rank: 'A' } })

    ws.close()
    await waitClose(ws)
  })

  it('broadcast() on instance 1 delivers to client on instance 2 via Redis pub/sub', async () => {
    const ws = await wsConnect(httpServer2, { 'x-session-id': 'pubsub-s1' })

    ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'fanout-table' } }))
    const joined = await nextMessage(ws)
    assert.equal(joined.type, 'JOINED')

    const msgPromise = nextMessage(ws)
    wss1.broadcast('fanout-table', 'TRICK_COMPLETE', { winnerSeat: 'south' })
    const msg = await msgPromise

    assert.equal(msg.type, 'TRICK_COMPLETE')
    assert.equal(msg.payload.winnerSeat, 'south')

    ws.close()
    await waitClose(ws)
  })

  it('broadcast() delivers to clients on both instances simultaneously', async () => {
    const ws1 = await wsConnect(httpServer1, { 'x-session-id': 'pubsub-s1' })
    const ws2 = await wsConnect(httpServer2, { 'x-session-id': 'pubsub-s2' })

    ws1.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'fanout-table' } }))
    ws2.send(JSON.stringify({ type: 'JOIN', payload: { tableId: 'fanout-table' } }))
    await nextMessage(ws1) // JOINED
    await nextMessage(ws2) // JOINED

    const p1 = nextMessage(ws1)
    const p2 = nextMessage(ws2)
    wss1.broadcast('fanout-table', 'BID_PLACED', { seat: 'east', bidType: 'number' })

    const [m1, m2] = await Promise.all([p1, p2])
    assert.equal(m1.type, 'BID_PLACED')
    assert.equal(m2.type, 'BID_PLACED')

    ws1.close(); ws2.close()
    await Promise.all([waitClose(ws1), waitClose(ws2)])
  })

  // ── Lobby channel ────────────────────────────────────────────────────────────

  it('JOIN_LOBBY receives JOINED_LOBBY ack', async () => {
    const ws = await wsConnect(httpServer1, { 'x-session-id': 'pubsub-s1' })

    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    const msg = await nextMessage(ws)

    assert.equal(msg.type, 'JOINED_LOBBY')

    ws.close()
    await waitClose(ws)
  })

  it('LEAVE_LOBBY receives LEFT_LOBBY ack', async () => {
    const ws = await wsConnect(httpServer1, { 'x-session-id': 'pubsub-s1' })

    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await nextMessage(ws) // JOINED_LOBBY

    ws.send(JSON.stringify({ type: 'LEAVE_LOBBY', payload: {} }))
    const msg = await nextMessage(ws)

    assert.equal(msg.type, 'LEFT_LOBBY')

    ws.close()
    await waitClose(ws)
  })

  it('broadcastLobby() on instance 2 delivers to lobby subscriber on instance 1', async () => {
    const ws = await wsConnect(httpServer1, { 'x-session-id': 'pubsub-s1' })

    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await nextMessage(ws) // JOINED_LOBBY

    const msgPromise = nextMessage(ws)
    wss2.broadcastLobby('TABLE_CREATED', { tableId: 'new-public-table', name: 'Friday Night' })
    const msg = await msgPromise

    assert.equal(msg.type, 'TABLE_CREATED')
    assert.equal(msg.payload.tableId, 'new-public-table')

    ws.close()
    await waitClose(ws)
  })

  it('broadcastLobby() delivers to lobby subscribers on both instances', async () => {
    const ws1 = await wsConnect(httpServer1, { 'x-session-id': 'pubsub-s1' })
    const ws2 = await wsConnect(httpServer2, { 'x-session-id': 'pubsub-s2' })

    ws1.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    ws2.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await nextMessage(ws1) // JOINED_LOBBY
    await nextMessage(ws2) // JOINED_LOBBY

    const p1 = nextMessage(ws1)
    const p2 = nextMessage(ws2)
    wss1.broadcastLobby('TABLE_REMOVED', { tableId: 'old-table' })

    const [m1, m2] = await Promise.all([p1, p2])
    assert.equal(m1.type, 'TABLE_REMOVED')
    assert.equal(m2.type, 'TABLE_REMOVED')

    ws1.close(); ws2.close()
    await Promise.all([waitClose(ws1), waitClose(ws2)])
  })

  it('lobby subscriber does NOT receive table room events', async () => {
    const ws = await wsConnect(httpServer1, { 'x-session-id': 'pubsub-s1' })

    ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    await nextMessage(ws) // JOINED_LOBBY

    let spuriousReceived = false
    ws.on('message', () => { spuriousReceived = true })

    // Broadcast to table room — lobby subscriber should NOT receive this
    wss1.broadcast('fanout-table', 'TURN_CHANGED', { activeSeat: 'west', phase: 'play' })

    await new Promise((r) => setTimeout(r, 80))
    assert.equal(spuriousReceived, false, 'lobby subscriber received a table room event unexpectedly')

    ws.close()
    await waitClose(ws)
  })
})
