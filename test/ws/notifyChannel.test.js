import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import WebSocket from 'ws'
import { createWsServer } from '../../server/ws/index.js'
import { getRedis, closeRedis } from '../../server/redis.js'

const skip = !process.env.REDIS_URL ? 'REDIS_URL must be set' : false

function wsConnect(server, headers = {}) {
  const { port } = server.address()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    ws.once('open', () => { setTimeout(() => resolve(ws), 100) })
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

describe('notifyPlayer() via Redis pub/sub', { skip }, () => {
  let httpServer1, wss1
  let httpServer2, wss2
  let redis

  before(async () => {
    redis = await getRedis()

    await redis.set('session:notify-s1', JSON.stringify({ playerId: 'notify-p1', username: 'NotifyUser1' }))
    await redis.set('session:notify-s2', JSON.stringify({ playerId: 'notify-p2', username: 'NotifyUser2' }))

    httpServer1 = http.createServer()
    wss1 = createWsServer(httpServer1, { redis })
    await wss1._subscriberReady
    await new Promise((resolve) => httpServer1.listen(0, '127.0.0.1', resolve))

    httpServer2 = http.createServer()
    wss2 = createWsServer(httpServer2, { redis })
    await wss2._subscriberReady
    await new Promise((resolve) => httpServer2.listen(0, '127.0.0.1', resolve))
  })

  after(async () => {
    for (const client of wss1.clients) client.terminate()
    for (const client of wss2.clients) client.terminate()
    await Promise.all([
      new Promise((resolve) => wss1.close(resolve)),
      new Promise((resolve) => wss2.close(resolve)),
    ])
    await Promise.all([
      new Promise((resolve) => httpServer1.close(resolve)),
      new Promise((resolve) => httpServer2.close(resolve)),
    ])

    await redis.del('session:notify-s1')
    await redis.del('session:notify-s2')

    await closeRedis()
  })

  it('notifyPlayer() on instance 2 delivers to client connected on instance 1', { timeout: 15000 }, async () => {
    const ws = await wsConnect(httpServer1, { 'x-session-id': 'notify-s1' })

    const msgPromise = nextMessage(ws)
    wss2.notifyPlayer('notify-p1', 'FRIEND_REQUEST', { fromPlayerId: 'notify-p2', fromUsername: 'NotifyUser2' })
    const msg = await msgPromise

    assert.equal(msg.type, 'FRIEND_REQUEST')
    assert.deepEqual(msg.payload, { fromPlayerId: 'notify-p2', fromUsername: 'NotifyUser2' })

    ws.close()
    await waitClose(ws)
  })

  it('notifyPlayer() on instance 1 delivers to client connected on instance 2', { timeout: 15000 }, async () => {
    const ws = await wsConnect(httpServer2, { 'x-session-id': 'notify-s2' })

    const msgPromise = nextMessage(ws)
    wss1.notifyPlayer('notify-p2', 'INVITE_RECEIVED', { tableId: 'some-table', fromUsername: 'NotifyUser1' })
    const msg = await msgPromise

    assert.equal(msg.type, 'INVITE_RECEIVED')
    assert.equal(msg.payload.tableId, 'some-table')

    ws.close()
    await waitClose(ws)
  })

  it('notify channel is torn down on disconnect — subsequent notifyPlayer() does not deliver', { timeout: 15000 }, async () => {
    const ws = await wsConnect(httpServer1, { 'x-session-id': 'notify-s1' })

    ws.close()
    await waitClose(ws)

    // Allow time for server-side cleanup (unsubscribe from Redis channel)
    await new Promise((r) => setTimeout(r, 200))

    // Reconnect a fresh client to listen for any stray messages
    const ws2 = await wsConnect(httpServer1, { 'x-session-id': 'notify-s2' })

    let spuriousReceived = false
    ws2.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'GHOST_EVENT') spuriousReceived = true
    })

    // Publish to the disconnected player's notify channel
    wss2.notifyPlayer('notify-p1', 'GHOST_EVENT', { should: 'not arrive' })

    await new Promise((r) => setTimeout(r, 200))
    assert.equal(spuriousReceived, false, 'event delivered to disconnected player notify channel')

    ws2.close()
    await waitClose(ws2)
  })
})
