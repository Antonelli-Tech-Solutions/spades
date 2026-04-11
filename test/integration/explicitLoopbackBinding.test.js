/**
 * Integration tests for issue #400: Bind test servers explicitly to 127.0.0.1.
 *
 * When `app.listen(0)` is called without a host argument, Node.js may bind to
 * 0.0.0.0 (all interfaces) on some platforms. If requests are then sent to
 * `http://127.0.0.1:<port>`, this can fail on hosts where 0.0.0.0 resolves
 * differently. The fix is to always pass '127.0.0.1' as the bind address:
 *
 *   app.listen(0, '127.0.0.1', () => { ... })
 *
 * These tests verify:
 *   1. A server bound to '127.0.0.1' reports that address in srv.address().
 *   2. The server is reachable at http://127.0.0.1:<port>.
 *   3. The bound port is a valid ephemeral port.
 *   4. Multiple servers bound to '127.0.0.1' get distinct ports.
 *   5. The server responds correctly to HTTP requests on the bound address.
 *   6. After close(), the server is no longer reachable.
 *   7. The pattern works with the build-info route (end-to-end).
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'

// ── Helper: start server bound explicitly to 127.0.0.1 ─────────────────────

function listenOnLoopback(app) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      resolve({
        server: srv,
        address: addr,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => srv.close(res)),
      })
    })
    srv.on('error', (err) => reject(err))
  })
}

// ── Helper: start server WITHOUT explicit host (the old/broken pattern) ─────

function listenWithoutHost(app) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      const addr = srv.address()
      resolve({
        server: srv,
        address: addr,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => srv.close(res)),
      })
    })
    srv.on('error', (err) => reject(err))
  })
}

function createApp() {
  const app = express()
  app.use(express.json())
  return app
}

// ── Explicit loopback binding tests ─────────────────────────────────────────

describe('explicit 127.0.0.1 binding (issue #400)', { timeout: 10000 }, () => {
  const servers = []

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop()
      await s.close()
    }
  })

  // --- Happy path: address is 127.0.0.1 ---

  it('srv.address().address is 127.0.0.1 when bound explicitly', { timeout: 5000 }, async () => {
    const app = createApp()
    const handle = await listenOnLoopback(app)
    servers.push(handle)

    assert.equal(handle.address.address, '127.0.0.1',
      'Server should be bound to 127.0.0.1, not 0.0.0.0 or ::')
  })

  it('srv.address().port is a positive integer', { timeout: 5000 }, async () => {
    const app = createApp()
    const handle = await listenOnLoopback(app)
    servers.push(handle)

    assert.ok(Number.isInteger(handle.address.port), 'Port should be an integer')
    assert.ok(handle.address.port > 0, `Expected positive port, got ${handle.address.port}`)
    assert.ok(handle.address.port < 65536, `Expected port < 65536, got ${handle.address.port}`)
  })

  it('server is reachable at http://127.0.0.1:<port>', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    const handle = await listenOnLoopback(app)
    servers.push(handle)

    const res = await fetch(`${handle.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
  })

  it('baseUrl uses 127.0.0.1, not 0.0.0.0', { timeout: 5000 }, async () => {
    const app = createApp()
    const handle = await listenOnLoopback(app)
    servers.push(handle)

    assert.match(handle.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/,
      'baseUrl should use 127.0.0.1')
    assert.ok(!handle.baseUrl.includes('0.0.0.0'),
      'baseUrl must not contain 0.0.0.0')
  })

  // --- Multiple servers get distinct ports ---

  it('two servers bound to 127.0.0.1 get different ports', { timeout: 5000 }, async () => {
    const app1 = createApp()
    const app2 = createApp()
    const handle1 = await listenOnLoopback(app1)
    const handle2 = await listenOnLoopback(app2)
    servers.push(handle1, handle2)

    assert.notEqual(handle1.address.port, handle2.address.port,
      'Two servers on port 0 should get different ephemeral ports')
  })

  // --- Server teardown ---

  it('server is not reachable after close()', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    const handle = await listenOnLoopback(app)
    const { baseUrl } = handle

    await handle.close()
    // Don't push to servers array — already closed

    await assert.rejects(
      () => fetch(`${baseUrl}/api/build-info`),
      (err) => {
        assert.ok(err, 'fetch should throw after server is closed')
        return true
      }
    )
  })

  // --- End-to-end: build-info route returns correct data ---

  it('build-info route responds with expected shape on loopback-bound server', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    const handle = await listenOnLoopback(app)
    servers.push(handle)

    const res = await fetch(`${handle.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok('commitShort' in body, 'Response should have commitShort field')
  })
})

// ── Contrast: without-host pattern may bind to a different address ──────────

describe('without-host binding contrast (issue #400)', { timeout: 10000 }, () => {
  const servers = []

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop()
      await s.close()
    }
  })

  it('without explicit host, address may be :: or 0.0.0.0 (not guaranteed 127.0.0.1)', { timeout: 5000 }, async () => {
    const app = createApp()
    const handle = await listenWithoutHost(app)
    servers.push(handle)

    // The address without explicit host is platform-dependent.
    // On most systems it will be :: (IPv6 all-interfaces) or 0.0.0.0.
    // The key assertion: it should NOT be 127.0.0.1 on most platforms,
    // demonstrating why explicit binding is needed.
    const addr = handle.address.address
    const isWildcard = addr === '::' || addr === '0.0.0.0'
    const isLoopback = addr === '127.0.0.1' || addr === '::1'

    // We accept either — the test documents the behavior rather than
    // asserting a specific platform outcome. The important thing is
    // that with explicit binding we ALWAYS get 127.0.0.1.
    assert.ok(isWildcard || isLoopback,
      `Expected a known address (::, 0.0.0.0, 127.0.0.1, ::1), got: ${addr}`)
  })

  it('explicit host guarantees 127.0.0.1 regardless of platform default', { timeout: 5000 }, async () => {
    const appWithout = createApp()
    const appWith = createApp()

    const handleWithout = await listenWithoutHost(appWithout)
    const handleWith = await listenOnLoopback(appWith)
    servers.push(handleWithout, handleWith)

    // The without-host server may or may not be 127.0.0.1
    // The with-host server is always 127.0.0.1
    assert.equal(handleWith.address.address, '127.0.0.1',
      'Explicit binding should always yield 127.0.0.1')
  })
})

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('loopback binding edge cases (issue #400)', { timeout: 10000 }, () => {
  const servers = []

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop()
      await s.close()
    }
  })

  it('address family is IPv4 when bound to 127.0.0.1', { timeout: 5000 }, async () => {
    const app = createApp()
    const handle = await listenOnLoopback(app)
    servers.push(handle)

    assert.equal(handle.address.family, 'IPv4',
      'Binding to 127.0.0.1 should result in IPv4 family')
  })

  it('listen error rejects the promise (e.g. invalid host)', { timeout: 5000 }, async () => {
    const app = createApp()

    // Attempting to bind to a non-local address should fail
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        const srv = app.listen(0, '192.0.2.1', () => {
          resolve(srv)
        })
        srv.on('error', (err) => reject(err))
      }),
      (err) => {
        // EADDRNOTAVAIL on most platforms when binding to a non-local address
        assert.ok(err instanceof Error, 'Should reject with an Error')
        return true
      }
    )
  })

  it('server bound to 127.0.0.1 handles concurrent requests', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    const handle = await listenOnLoopback(app)
    servers.push(handle)

    const requests = Array.from({ length: 5 }, () =>
      fetch(`${handle.baseUrl}/api/build-info`).then((r) => r.status)
    )
    const statuses = await Promise.all(requests)

    assert.deepStrictEqual(statuses, [200, 200, 200, 200, 200],
      'All concurrent requests should succeed')
  })
})
