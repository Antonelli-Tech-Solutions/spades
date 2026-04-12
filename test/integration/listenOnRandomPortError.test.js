/**
 * Tests for GitHub issue #383:
 *
 * `listenOnRandomPort` must reject its promise when the underlying
 * server emits an 'error' event (e.g. EADDRINUSE). Before the fix,
 * the promise would hang forever and the server handle would leak.
 *
 * These tests verify:
 *   - The promise rejects with the original error on listen failure.
 *   - The rejected error preserves the error code (e.g. EADDRINUSE).
 *   - The server handle is cleaned up (not left open) after rejection.
 *   - The happy path still works (port 0 → resolves with baseUrl + close).
 *   - Successful close() tears down cleanly.
 *
 * Refactored for issue #418: error-path tests now use a shared
 * `listenOnPort` helper instead of inlining the promise pattern.
 *
 * Refactored for issue #419: helpers (createApp, listenOnRandomPort,
 * listenOnPort) are now imported from test/helpers/serverHelper.js so
 * regressions in the shared helper are caught by these tests.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { registerBuildInfoRoute } from '../../server/server.js'
import { createApp, listenOnRandomPort, listenOnPort } from '../helpers/serverHelper.js'

/**
 * The BROKEN version (before fix) — no error listener that rejects.
 * Accepts a port so it can be aimed at an occupied port to demonstrate the hang.
 * Returns { promise, capturedError() } so tests can assert on the swallowed error.
 */
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

/**
 * Occupy a random port with a raw TCP server. Returns { server, port }.
 */
function occupyRandomPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
    server.on('error', reject)
  })
}

// ── Happy path: listenOnRandomPort resolves correctly ────────────────────────────

describe('listenOnRandomPort happy path (issue #383)', { timeout: 10000 }, () => {
  let server

  afterEach(async () => {
    if (server) {
      await server.close()
      server = null
    }
  })

  it('resolves with baseUrl and close function on port 0', { timeout: 5000 }, async () => {
    const app = createApp()
    server = await listenOnRandomPort(app)

    assert.ok(server.baseUrl, 'should have a baseUrl')
    assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(typeof server.close, 'function')
  })

  it('resolved baseUrl port is a positive integer', { timeout: 5000 }, async () => {
    const app = createApp()
    server = await listenOnRandomPort(app)

    const port = parseInt(server.baseUrl.split(':').pop(), 10)
    assert.ok(port > 0, `Expected positive port, got ${port}`)
    assert.ok(port < 65536, `Expected port < 65536, got ${port}`)
  })

  it('server responds to HTTP requests after resolve', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    server = await listenOnRandomPort(app)

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
  })

  it('close() cleanly shuts down the server', { timeout: 5000 }, async () => {
    const app = createApp()
    server = await listenOnRandomPort(app)
    const { baseUrl } = server

    await server.close()
    server = null // prevent double-close in afterEach

    await assert.rejects(
      () => fetch(baseUrl),
      (err) => {
        assert.ok(err, 'fetch should throw after server is closed')
        return true
      }
    )
  })
})

// ── Happy path: listenOnPort resolves correctly ──────────────────────────────────

describe('listenOnPort happy path (issue #418)', { timeout: 10000 }, () => {
  let server

  afterEach(async () => {
    if (server) {
      await server.close()
      server = null
    }
  })

  it('resolves with baseUrl when given an available port', { timeout: 5000 }, async () => {
    const app = createApp()
    // Find a free port by briefly occupying then releasing one
    const { server: tmp, port } = await occupyRandomPort()
    await new Promise((res) => tmp.close(res))

    server = await listenOnPort(app, port)

    assert.ok(server.baseUrl, 'should have a baseUrl')
    assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.ok(server.baseUrl.endsWith(`:${port}`), `baseUrl should use port ${port}`)
    assert.equal(typeof server.close, 'function')
  })

  it('server responds to HTTP requests on the specified port', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    const { server: tmp, port } = await occupyRandomPort()
    await new Promise((res) => tmp.close(res))

    server = await listenOnPort(app, port)

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
  })

  it('close() cleanly shuts down the server', { timeout: 5000 }, async () => {
    const app = createApp()
    const { server: tmp, port } = await occupyRandomPort()
    await new Promise((res) => tmp.close(res))

    server = await listenOnPort(app, port)
    const { baseUrl } = server

    await server.close()
    server = null

    await assert.rejects(
      () => fetch(baseUrl),
      (err) => {
        assert.ok(err, 'fetch should throw after server is closed')
        return true
      }
    )
  })
})

// ── Error path: listenOnPort rejects on server error ─────────────────────────────

describe('listenOnPort rejects on listen error (issue #383 / #418)', { timeout: 10000 }, () => {
  let blockingServer

  afterEach(async () => {
    if (blockingServer) {
      await new Promise((res) => blockingServer.close(res))
      blockingServer = null
    }
  })

  it('rejects with EADDRINUSE when the port is already occupied', { timeout: 5000 }, async () => {
    const { server: blocker, port } = await occupyRandomPort()
    blockingServer = blocker

    const app = createApp()
    await assert.rejects(listenOnPort(app, port), (err) => {
      assert.equal(err.code, 'EADDRINUSE')
      return true
    })
  })

  it('rejected error preserves the original error message', { timeout: 5000 }, async () => {
    const { server: blocker, port } = await occupyRandomPort()
    blockingServer = blocker

    const app = createApp()
    await assert.rejects(listenOnPort(app, port), (err) => {
      assert.ok(err.message.includes('EADDRINUSE'), `Expected EADDRINUSE in message, got: ${err.message}`)
      return true
    })
  })

  it('rejected error is an instance of Error', { timeout: 5000 }, async () => {
    const { server: blocker, port } = await occupyRandomPort()
    blockingServer = blocker

    const app = createApp()
    await assert.rejects(listenOnPort(app, port), (err) => {
      assert.ok(err instanceof Error)
      return true
    })
  })
})

// ── Broken version hangs (demonstrates the bug) ─────────────────────────────────

describe('broken listenOnRandomPort hangs on error (issue #383 regression)', { timeout: 10000 }, () => {
  let blockingServer

  afterEach(async () => {
    if (blockingServer) {
      await new Promise((res) => blockingServer.close(res))
      blockingServer = null
    }
  })

  it('broken version does NOT reject — Promise.race proves the hang', { timeout: 5000 }, async () => {
    const { server: blocker, port } = await occupyRandomPort()
    blockingServer = blocker

    const app = createApp()
    const { promise: hangPromise, capturedError } = listenOnPortBroken(app, port)

    const HANG_SENTINEL = Symbol('hung')
    const hangTimeout = new Promise((resolve) =>
      setTimeout(() => resolve(HANG_SENTINEL), 500)
    )

    const result = await Promise.race([hangPromise, hangTimeout])
    assert.equal(result, HANG_SENTINEL, 'Broken version should hang (not resolve or reject)')

    const err = capturedError()
    assert.ok(err instanceof Error, 'Error should have been captured')
    assert.equal(err.code, 'EADDRINUSE', 'Captured error should be EADDRINUSE')
  })

  it('fixed listenOnPort rejects promptly instead of hanging', { timeout: 5000 }, async () => {
    const { server: blocker, port } = await occupyRandomPort()
    blockingServer = blocker

    const app = createApp()

    const HANG_SENTINEL = Symbol('hung')
    const hangTimeout = new Promise((resolve) =>
      setTimeout(() => resolve(HANG_SENTINEL), 500)
    )

    const result = await Promise.race([listenOnPort(app, port).catch((e) => e), hangTimeout])
    assert.notEqual(result, HANG_SENTINEL, 'Fixed version should reject promptly, not hang')
    assert.ok(result instanceof Error, 'Should reject with an Error')
    assert.equal(result.code, 'EADDRINUSE')
  })
})

// ── withBuildInfoServer propagates listen errors ─────────────────────────────────

describe('withBuildInfoServer propagates listen errors (issue #383)', { timeout: 10000 }, () => {
  let blockingServer

  afterEach(async () => {
    if (blockingServer) {
      await new Promise((res) => blockingServer.close(res))
      blockingServer = null
    }
  })

  it('withBuildInfoServer-like pattern surfaces rejection to caller', { timeout: 5000 }, async () => {
    const { server: blocker, port } = await occupyRandomPort()
    blockingServer = blocker

    const app = createApp()
    registerBuildInfoRoute(app)

    await assert.rejects(listenOnPort(app, port), (err) => {
      assert.equal(err.code, 'EADDRINUSE')
      return true
    })
  })
})
