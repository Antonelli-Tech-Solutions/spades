/**
 * Tests for GitHub issue #327:
 *
 * The build-info env-isolation tests (issue #317) create the server once in
 * before() with a single registerBuildInfoRoute(app) call. This works because
 * the route handler reads process.env.GIT_COMMIT_SHA at request time, not at
 * registration time. However, the idempotency guard (issue #311) uses
 * app.locals._buildInfoRegistered to skip duplicate registrations on the SAME
 * app instance. If a test suite tried to call registerBuildInfoRoute(app) again
 * on an already-registered app, the call would silently no-op.
 *
 * This file explicitly tests the coupling between:
 *   1. The idempotency guard being per-app (not global)
 *   2. Env vars being read at request time (not registration time)
 *   3. The single-server-per-suite pattern relying on both of the above
 *
 * DEPENDENCY NOTE: These tests depend on registerBuildInfoRoute using
 * app.locals._buildInfoRegistered as its idempotency guard (commit b51ceba).
 * If the guard mechanism changes, these tests must be updated.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

function createApp() {
  const app = express()
  app.use(express.json())
  return app
}

function listenOnRandomPort(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const { port } = srv.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => srv.close(res)),
      })
    })
  })
}

const ENV_KEY = 'GIT_COMMIT_SHA'

// ── Idempotency guard is per-app, not global ────────────────────────────────

describe('idempotency guard is per-app instance (issue #327)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)
  let serverA, serverB

  before(async () => {
    const appA = createApp()
    registerBuildInfoRoute(appA)
    serverA = await listenOnRandomPort(appA)

    const appB = createApp()
    registerBuildInfoRoute(appB)
    serverB = await listenOnRandomPort(appB)
  })

  after(async () => {
    await serverA.close()
    await serverB.close()
    restoreEnv(ENV_KEY, savedSha)
  })

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('both independent app instances serve the route', { timeout: 5000 }, async () => {
    process.env.GIT_COMMIT_SHA = 'aaaa111122223333444455556666777788889999'

    const [resA, resB] = await Promise.all([
      fetch(`${serverA.baseUrl}/api/build-info`),
      fetch(`${serverB.baseUrl}/api/build-info`),
    ])

    assert.equal(resA.status, 200)
    assert.equal(resB.status, 200)

    const bodyA = await resA.json()
    const bodyB = await resB.json()
    assert.equal(bodyA.commitShort, 'aaaa111')
    assert.equal(bodyB.commitShort, 'aaaa111')
  })

  it('env change is reflected on both servers simultaneously', { timeout: 5000 }, async () => {
    process.env.GIT_COMMIT_SHA = 'bbbb222233334444555566667777888899990000'
    const resA1 = await fetch(`${serverA.baseUrl}/api/build-info`)
    const bodyA1 = await resA1.json()
    assert.equal(bodyA1.commitShort, 'bbbb222')

    process.env.GIT_COMMIT_SHA = 'cccc333344445555666677778888999900001111'
    const [resA2, resB2] = await Promise.all([
      fetch(`${serverA.baseUrl}/api/build-info`),
      fetch(`${serverB.baseUrl}/api/build-info`),
    ])
    const bodyA2 = await resA2.json()
    const bodyB2 = await resB2.json()
    assert.equal(bodyA2.commitShort, 'cccc333')
    assert.equal(bodyB2.commitShort, 'cccc333')
  })
})

// ── Silent no-op on re-registration of same app ─────────────────────────────

describe('re-registration on same app is a silent no-op (issue #327)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('second registerBuildInfoRoute call on same app does not throw', () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    assert.doesNotThrow(() => registerBuildInfoRoute(app))
  })

  it('guard flag is set after first registration', () => {
    const app = createApp()
    assert.equal(app.locals._buildInfoRegistered, undefined)
    registerBuildInfoRoute(app)
    assert.equal(app.locals._buildInfoRegistered, true)
  })

  it('second call does not add a duplicate route handler', () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)

    const layers = app._router.stack.filter(
      (layer) => layer.route && layer.route.path === '/api/build-info'
    )
    assert.equal(layers.length, 1,
      'Expected exactly one /api/build-info handler after two registrations')
  })

  it('route still works correctly after idempotent re-registration', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      process.env.GIT_COMMIT_SHA = 'noop1111222233334444555566667777888899aa'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.commitShort, 'noop111')
    } finally {
      await server.close()
    }
  })
})

// ── Request-time env reading vs registration-time ───────────────────────────

describe('env var is read at request time, not registration time (issue #327)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)
  let server

  before(async () => {
    process.env.GIT_COMMIT_SHA = 'regtime1111222233334444555566667777888899'
    const app = createApp()
    registerBuildInfoRoute(app)
    server = await listenOnRandomPort(app)
  })

  after(async () => {
    await server.close()
    restoreEnv(ENV_KEY, savedSha)
  })

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('changing env after registration changes the response', { timeout: 5000 }, async () => {
    process.env.GIT_COMMIT_SHA = 'reqtime2222333344445555666677778888999900'
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()
    assert.equal(body.commitShort, 'reqtime')
  })

  it('deleting env after registration returns null', { timeout: 5000 }, async () => {
    delete process.env.GIT_COMMIT_SHA
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()
    assert.equal(body.commitShort, null)
  })

  it('multiple env changes between requests all reflected correctly', { timeout: 5000 }, async () => {
    const values = [
      { sha: 'val_a_11222233334444555566667777888899001111', expected: 'val_a_1' },
      { sha: 'val_b_22333344445555666677778888999900112222', expected: 'val_b_2' },
      { sha: 'val_c_33444455556666777788889999000011223333', expected: 'val_c_3' },
    ]

    for (const { sha, expected } of values) {
      process.env.GIT_COMMIT_SHA = sha
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, expected,
        `Expected ${expected} but got ${body.commitShort} for SHA ${sha}`)
    }
  })
})

// ── Fresh app per describe block works despite global guard concerns ────────

describe('fresh app per describe block is safe (issue #327)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('sequential fresh apps each get their own working route', { timeout: 5000 }, async () => {
    const servers = []

    try {
      for (let i = 0; i < 3; i++) {
        const app = createApp()
        registerBuildInfoRoute(app)
        const srv = await listenOnRandomPort(app)
        servers.push(srv)
      }

      process.env.GIT_COMMIT_SHA = 'fresh_app_test_sha_1234567890abcdef1234'
      for (const srv of servers) {
        const res = await fetch(`${srv.baseUrl}/api/build-info`)
        assert.equal(res.status, 200, `Server at ${srv.baseUrl} should respond 200`)
        const body = await res.json()
        assert.equal(body.commitShort, 'fresh_a')
      }
    } finally {
      for (const srv of servers) {
        await srv.close()
      }
    }
  })

  it('guard flag is independent across app instances', () => {
    const app1 = createApp()
    const app2 = createApp()

    registerBuildInfoRoute(app1)
    assert.equal(app1.locals._buildInfoRegistered, true)
    assert.equal(app2.locals._buildInfoRegistered, undefined)

    registerBuildInfoRoute(app2)
    assert.equal(app2.locals._buildInfoRegistered, true)
  })
})
