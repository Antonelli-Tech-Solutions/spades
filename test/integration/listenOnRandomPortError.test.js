/**
 * Tests for GitHub issue #383:
 *
 * `listenOnRandomPort` must reject its promise when the underlying
 * server emits an 'error' event (e.g. EADDRINUSE). Before the fix,
 * the promise would hang forever and the server handle would leak.
 *
 * Refactored for issue #422: consolidated from ~300 lines to ~100
 * by extracting helpers and combining redundant assertions.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { registerBuildInfoRoute } from '../../server/server.js'
import { createApp, listenOnRandomPort, listenOnPort } from '../helpers/serverHelper.js'

function listenOnPortBroken(app, port) {
  let swallowedError = null
  const promise = new Promise((resolve) => {
    const srv = app.listen(port, '127.0.0.1', () => {
      const { address, port: actualPort } = srv.address()
      resolve({
        baseUrl: `http://${address}:${actualPort}`,
        close: () => new Promise((res) => srv.close(res)),
      })
    })
    srv.on('error', (err) => { swallowedError = err })
  })
  return { promise, capturedError: () => swallowedError }
}

function occupyRandomPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
    server.on('error', reject)
  })
}

let cleanup = []

afterEach(async () => {
  for (const fn of cleanup) await fn()
  cleanup = []
})

function track(serverObj) {
  cleanup.push(() => serverObj.close())
  return serverObj
}

function trackRaw(rawServer) {
  cleanup.push(() => new Promise((res) => rawServer.close(res)))
  return rawServer
}

async function occupyPort() {
  const { server, port } = await occupyRandomPort()
  trackRaw(server)
  return port
}

describe('listenOnRandomPort happy path (issue #383)', { timeout: 10000 }, () => {
  it('resolves with baseUrl, port, and close on port 0', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    const server = track(await listenOnRandomPort(app))

    assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(typeof server.close, 'function')
    const port = parseInt(server.baseUrl.split(':').pop(), 10)
    assert.ok(port > 0 && port < 65536)

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
  })

  it('close() cleanly shuts down the server', { timeout: 5000 }, async () => {
    const app = createApp()
    const server = await listenOnRandomPort(app)
    const { baseUrl } = server
    await server.close()

    await assert.rejects(() => fetch(baseUrl), (err) => {
      assert.ok(err)
      return true
    })
  })
})

describe('listenOnPort rejects on listen error (issue #383 / #418)', { timeout: 10000 }, () => {
  it('rejects with EADDRINUSE Error when the port is occupied', { timeout: 5000 }, async () => {
    const port = await occupyPort()
    const app = createApp()

    await assert.rejects(listenOnPort(app, port), (err) => {
      assert.ok(err instanceof Error)
      assert.equal(err.code, 'EADDRINUSE')
      assert.ok(err.message.includes('EADDRINUSE'))
      return true
    })
  })
})

describe('broken listenOnRandomPort hangs on error (issue #383 regression)', { timeout: 10000 }, () => {
  it('broken version hangs; fixed version rejects promptly', { timeout: 5000 }, async () => {
    const port = await occupyPort()
    const HANG_SENTINEL = Symbol('hung')

    const brokenApp = createApp()
    const { promise: hangPromise, capturedError } = listenOnPortBroken(brokenApp, port)
    const hangTimeout = new Promise((resolve) => setTimeout(() => resolve(HANG_SENTINEL), 500))
    const brokenResult = await Promise.race([hangPromise, hangTimeout])
    assert.equal(brokenResult, HANG_SENTINEL, 'Broken version should hang')
    assert.ok(capturedError() instanceof Error)
    assert.equal(capturedError().code, 'EADDRINUSE')

    const fixedApp = createApp()
    const fixedTimeout = new Promise((resolve) => setTimeout(() => resolve(HANG_SENTINEL), 500))
    const fixedResult = await Promise.race([listenOnPort(fixedApp, port).catch((e) => e), fixedTimeout])
    assert.notEqual(fixedResult, HANG_SENTINEL, 'Fixed version should reject promptly')
    assert.ok(fixedResult instanceof Error)
    assert.equal(fixedResult.code, 'EADDRINUSE')
  })
})

describe('withBuildInfoServer propagates listen errors (issue #383)', { timeout: 10000 }, () => {
  it('surfaces EADDRINUSE rejection to caller', { timeout: 5000 }, async () => {
    const port = await occupyPort()
    const app = createApp()
    registerBuildInfoRoute(app)

    await assert.rejects(listenOnPort(app, port), (err) => {
      assert.equal(err.code, 'EADDRINUSE')
      return true
    })
  })
})
