/**
 * Integration tests for issue #303: build-info route isolation.
 *
 * The original buildInfo.test.js calls handler(app) without passing redis,
 * mailer, or other dependencies. This registers ALL routes in a broken state.
 * These tests verify that:
 *   1. A standalone registerBuildInfoRoute() helper exists and works
 *      without any external dependencies (redis, mailer, wss).
 *   2. The refactored buildInfo test helper uses the isolated route
 *      registration instead of the full handler().
 *   3. The full handler() still registers the build-info route correctly
 *      (no regression).
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Start a minimal Express server using only the isolated build-info route.
 * This is the pattern the refactored buildInfo.test.js should use.
 */
async function startIsolatedServer() {
  const { registerBuildInfoRoute } = await import('../../server/server.js')
  const app = express()
  app.use(express.json())
  registerBuildInfoRoute(app)

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      })
    })
  })
}

// ── Tests: registerBuildInfoRoute exists and is exported ─────────────────

describe('registerBuildInfoRoute export', { timeout: 10000 }, () => {
  it('is exported as a named function from server.js', async () => {
    const mod = await import('../../server/server.js')
    assert.equal(typeof mod.registerBuildInfoRoute, 'function',
      'server.js must export registerBuildInfoRoute')
  })

  it('is a separate export from handler', async () => {
    const mod = await import('../../server/server.js')
    assert.notEqual(mod.registerBuildInfoRoute, mod.handler,
      'registerBuildInfoRoute must not be the same function as handler')
  })
})

// ── Tests: isolated route works without dependencies ────────────────────

describe('build-info route registered in isolation', { timeout: 10000 }, () => {
  let server
  const savedSha = process.env.GIT_COMMIT_SHA

  before(async () => {
    server = await startIsolatedServer()
  })

  after(async () => {
    await server.close()
  })

  afterEach(() => {
    if (savedSha !== undefined) {
      process.env.GIT_COMMIT_SHA = savedSha
    } else {
      delete process.env.GIT_COMMIT_SHA
    }
  })

  it('returns 200 with commitShort when GIT_COMMIT_SHA is set', async () => {
    process.env.GIT_COMMIT_SHA = 'abc1234def5678901234567890abcdef12345678'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.commitShort, 'abc1234')
  })

  it('returns 200 with null commitShort when GIT_COMMIT_SHA is not set', async () => {
    delete process.env.GIT_COMMIT_SHA

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.commitShort, null)
  })

  it('responds with JSON content type', async () => {
    process.env.GIT_COMMIT_SHA = 'abc1234'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.ok(res.headers.get('content-type').includes('application/json'))
  })

  it('does not register any other routes', async () => {
    // Auth routes should NOT be registered on the isolated server
    const loginRes = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test', password: 'test' }),
    })
    // Express returns 404 for unregistered routes
    assert.equal(loginRes.status, 404,
      'isolated server must not register auth routes')

    const tablesRes = await fetch(`${server.baseUrl}/api/tables`)
    assert.equal(tablesRes.status, 404,
      'isolated server must not register lobby routes')
  })
})

// ── Tests: handler() still registers build-info (no regression) ─────────

describe('handler() still registers /api/build-info', { timeout: 10000 }, () => {
  let server
  const savedSha = process.env.GIT_COMMIT_SHA

  before(async () => {
    const { handler } = await import('../../server/server.js')
    const app = express()
    app.use(express.json())
    handler(app, {
      mailer: async () => {},
      passwordResetMailer: async () => {},
      redis: null,
    })

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        const { port } = srv.address()
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((res) => srv.close(res)),
        })
      })
    })
  })

  after(async () => {
    await server.close()
  })

  afterEach(() => {
    if (savedSha !== undefined) {
      process.env.GIT_COMMIT_SHA = savedSha
    } else {
      delete process.env.GIT_COMMIT_SHA
    }
  })

  it('build-info route is still accessible via full handler', async () => {
    process.env.GIT_COMMIT_SHA = 'deadbeef1234567890abcdef1234567890abcdef'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.commitShort, 'deadbee')
  })
})

// ── Tests: registerBuildInfoRoute is safe to call multiple times ─────────

describe('registerBuildInfoRoute idempotency', { timeout: 10000 }, () => {
  let server
  const savedSha = process.env.GIT_COMMIT_SHA

  before(async () => {
    const { registerBuildInfoRoute } = await import('../../server/server.js')
    const app = express()
    app.use(express.json())
    // Register twice — should not throw or break
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        const { port } = srv.address()
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((res) => srv.close(res)),
        })
      })
    })
  })

  after(async () => {
    await server.close()
  })

  afterEach(() => {
    if (savedSha !== undefined) {
      process.env.GIT_COMMIT_SHA = savedSha
    } else {
      delete process.env.GIT_COMMIT_SHA
    }
  })

  it('still returns a single valid response when registered twice', async () => {
    process.env.GIT_COMMIT_SHA = 'abc1234def5678901234567890abcdef12345678'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.commitShort, 'abc1234')
  })
})
