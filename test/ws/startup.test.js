import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import WebSocket from 'ws'
import { createWsServer } from '../../server/ws/index.js'
import { getRedis, closeRedis } from '../../server/redis.js'

const skip = !process.env.REDIS_URL ? 'REDIS_URL must be set' : false

const TEST_TIMEOUT_MS = 5000

function wsConnect(server, headers = {}, timeoutMs = TEST_TIMEOUT_MS) {
  const { port } = server.address()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error(`wsConnect timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    ws.once('open', () => { clearTimeout(timer); resolve(ws) })
    ws.once('error', (err) => { clearTimeout(timer); reject(err) })
    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer)
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }))
    })
  })
}

function waitClose(ws, timeoutMs = TEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve(ws._closeCode ?? ws.closeCode)
    const timer = setTimeout(() => {
      reject(new Error(`waitClose timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    ws.once('close', (code) => { clearTimeout(timer); resolve(code) })
  })
}

describe('app.js WS_PORT startup branching', { skip }, () => {
  let redis

  before(async () => {
    redis = await getRedis()
    await redis.set(
      'session:startup-session',
      JSON.stringify({ playerId: 'startup-player', username: 'StartupUser' }),
    )
  })

  after(async () => {
    await redis.del('session:startup-session')
    await closeRedis()
  })

  // ── WS_PORT === PORT: shared HTTP server ─────────────────────────────────────

  describe('WS_PORT === PORT (shared HTTP server)', () => {
    let httpServer, wss

    before(async () => {
      // Mirrors the app.js branch: createWsServer(httpServer, { redis })
      httpServer = http.createServer()
      wss = createWsServer(httpServer, { redis })
      await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    })

    after(async () => {
      wss.close()
      await new Promise((resolve) => httpServer.close(resolve))
    })

    it('accepts authenticated WebSocket connections on the shared server', { timeout: TEST_TIMEOUT_MS }, async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': 'startup-session' })
      assert.equal(ws.readyState, WebSocket.OPEN)
      ws.close()
      await waitClose(ws)
    })

    it('rejects unauthenticated WebSocket connections on the shared server', { timeout: TEST_TIMEOUT_MS }, async () => {
      const err = await wsConnect(httpServer).then(
        () => { throw new Error('expected rejection') },
        (e) => e,
      )
      assert.ok(
        err.statusCode === 401 || err.message.includes('401'),
        `expected 401, got: ${err.message}`,
      )
    })
  })

  // ── WS_PORT !== PORT: dedicated WebSocket server ─────────────────────────────

  describe('WS_PORT !== PORT (dedicated WebSocket server)', () => {
    let httpServer, wsHttpServer, wss

    before(async () => {
      // Mirrors the app.js branch: separate wsHttpServer for WebSocket traffic
      httpServer = http.createServer()
      wsHttpServer = http.createServer()
      wss = createWsServer(wsHttpServer, { redis })
      await Promise.all([
        new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve)),
        new Promise((resolve) => wsHttpServer.listen(0, '127.0.0.1', resolve)),
      ])
    })

    after(async () => {
      wss.close()
      await Promise.all([
        new Promise((resolve) => httpServer.close(resolve)),
        new Promise((resolve) => wsHttpServer.close(resolve)),
      ])
    })

    it('dedicated WS server and main HTTP server listen on different ports', { timeout: TEST_TIMEOUT_MS }, () => {
      const wsPort = wsHttpServer.address().port
      const httpPort = httpServer.address().port
      assert.notEqual(wsPort, httpPort, 'WS server and HTTP server must be on different ports')
    })

    it('accepts authenticated WebSocket connections on the dedicated WS server', { timeout: TEST_TIMEOUT_MS }, async () => {
      const ws = await wsConnect(wsHttpServer, { 'x-session-id': 'startup-session' })
      assert.equal(ws.readyState, WebSocket.OPEN)
      ws.close()
      await waitClose(ws)
    })

    it('rejects unauthenticated WebSocket connections on the dedicated WS server', { timeout: TEST_TIMEOUT_MS }, async () => {
      const err = await wsConnect(wsHttpServer).then(
        () => { throw new Error('expected rejection') },
        (e) => e,
      )
      assert.ok(
        err.statusCode === 401 || err.message.includes('401'),
        `expected 401, got: ${err.message}`,
      )
    })

    it('WebSocket upgrade is not handled on the main HTTP server', { timeout: TEST_TIMEOUT_MS }, async () => {
      // The main HTTP server has no WS handler attached — the upgrade should fail or be refused.
      // Node.js destroys the socket when no 'upgrade' listener is present, causing an ECONNRESET
      // or similar error on the client side.
      const err = await wsConnect(httpServer, { 'x-session-id': 'startup-session' }).then(
        () => { throw new Error('expected connection to main HTTP server to fail') },
        (e) => e,
      )
      assert.ok(err instanceof Error, 'expected an error when connecting to main server (no WS handler)')
    })
  })
})
