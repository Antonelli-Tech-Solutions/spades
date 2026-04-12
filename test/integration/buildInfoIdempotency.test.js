/**
 * Integration tests for issue #311: registerBuildInfoRoute idempotency guard.
 *
 * Calling registerBuildInfoRoute(app) multiple times should not add duplicate
 * handlers to Express's router stack. The guard uses app.locals to track
 * whether the route has already been registered.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'

describe('registerBuildInfoRoute idempotency guard', { timeout: 10000 }, () => {
  let app
  let server
  let baseUrl
  const savedSha = process.env.GIT_COMMIT_SHA

  before(async () => {
    app = express()
    app.use(express.json())

    // Register the route three times
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        const { port } = srv.address()
        baseUrl = `http://127.0.0.1:${port}`
        resolve(srv)
      })
    })
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
    // No env restoration here — afterEach already handles it reliably.
    // See issue #366 and buildInfoIdempotencyAfterHookSafety.test.js for proof
    // that the after hook env restore is redundant (restoreEnv is idempotent,
    // afterEach fires even on assertion failures, and try/finally covers inline cases).
  })

  afterEach(() => {
    if (savedSha !== undefined) {
      process.env.GIT_COMMIT_SHA = savedSha
    } else {
      delete process.env.GIT_COMMIT_SHA
    }
  })

  it('sets the _buildInfoRegistered flag on app.locals', () => {
    assert.equal(app.locals._buildInfoRegistered, true)
  })

  // app._router.stack is an undocumented Express internal; may break on major upgrades.
  it('only adds one route handler to the stack despite multiple calls', () => {
    const buildInfoLayers = app._router.stack.filter(
      (layer) => layer.route && layer.route.path === '/api/build-info'
    )
    assert.equal(buildInfoLayers.length, 1,
      'Expected exactly one /api/build-info handler in the router stack')
  })

  it('still returns a valid response after multiple registrations', async () => {
    try {
      process.env.GIT_COMMIT_SHA = 'idempotent123456789012345678901234567890'

      const res = await fetch(`${baseUrl}/api/build-info`)
      assert.equal(res.status, 200)

      const body = await res.json()
      assert.equal(body.commitShort, 'idempot')
    } finally {
      if (savedSha !== undefined) {
        process.env.GIT_COMMIT_SHA = savedSha
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }
  })

  it('works correctly on a fresh app instance (guard is per-app, not global)', async () => {
    const freshApp = express()
    freshApp.use(express.json())

    // Should succeed on a new app even though the first app was already registered
    registerBuildInfoRoute(freshApp)

    const freshServer = await new Promise((resolve) => {
      const srv = freshApp.listen(0, () => {
        resolve(srv)
      })
    })

    try {
      const { port } = freshServer.address()
      process.env.GIT_COMMIT_SHA = 'freshapp1234567890abcdef1234567890abcdef'

      const res = await fetch(`http://127.0.0.1:${port}/api/build-info`)
      assert.equal(res.status, 200)

      const body = await res.json()
      assert.equal(body.commitShort, 'freshap')
    } finally {
      if (savedSha !== undefined) {
        process.env.GIT_COMMIT_SHA = savedSha
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
      await new Promise((resolve) => freshServer.close(resolve))
    }
  })
})
