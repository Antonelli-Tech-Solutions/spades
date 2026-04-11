/**
 * Tests for GitHub issue #344:
 *
 * Validates that the env save/restore helper (`test/helpers/envHelper.js`)
 * correctly replaces the duplicated 5-line save/restore pattern that was
 * copy-pasted ~15 times in buildInfoIdempotencyServerCoupling.test.js.
 *
 * Part 1: Unit tests for saveEnv/restoreEnv helpers themselves
 * Part 2: Re-implementation of all original coupling tests using the helpers,
 *   proving the refactored approach is functionally equivalent
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Part 1: saveEnv / restoreEnv helper correctness ─────────────────────────

describe('saveEnv/restoreEnv helpers (issue #344)', { timeout: 2000 }, () => {
  const TEST_KEY = '__ENVHELPER_TEST_KEY__'

  afterEach(() => {
    // Always clean up the test key regardless of test outcome
    delete process.env[TEST_KEY]
  })

  it('saveEnv returns undefined when env var is not set', () => {
    delete process.env[TEST_KEY]
    const saved = saveEnv(TEST_KEY)
    assert.equal(saved, undefined)
  })

  it('saveEnv returns the current value when env var is set', () => {
    process.env[TEST_KEY] = 'hello'
    const saved = saveEnv(TEST_KEY)
    assert.equal(saved, 'hello')
  })

  it('saveEnv returns empty string for empty env var (not undefined)', () => {
    process.env[TEST_KEY] = ''
    const saved = saveEnv(TEST_KEY)
    assert.equal(saved, '')
  })

  it('restoreEnv sets the var when savedValue is a string', () => {
    delete process.env[TEST_KEY]
    restoreEnv(TEST_KEY, 'restored_value')
    assert.equal(process.env[TEST_KEY], 'restored_value')
  })

  it('restoreEnv deletes the var when savedValue is undefined', () => {
    process.env[TEST_KEY] = 'should_be_removed'
    restoreEnv(TEST_KEY, undefined)
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false)
  })

  it('restoreEnv sets empty string correctly (does not delete)', () => {
    delete process.env[TEST_KEY]
    restoreEnv(TEST_KEY, '')
    assert.equal(process.env[TEST_KEY], '')
    assert.equal(Object.hasOwn(process.env, TEST_KEY), true)
  })

  it('round-trip: save then restore preserves original set value', () => {
    process.env[TEST_KEY] = 'original'
    const saved = saveEnv(TEST_KEY)
    process.env[TEST_KEY] = 'modified'
    restoreEnv(TEST_KEY, saved)
    assert.equal(process.env[TEST_KEY], 'original')
  })

  it('round-trip: save then restore preserves original unset state', () => {
    delete process.env[TEST_KEY]
    const saved = saveEnv(TEST_KEY)
    process.env[TEST_KEY] = 'temporary'
    restoreEnv(TEST_KEY, saved)
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false)
  })

  it('restoreEnv is idempotent — calling it twice with same value is safe', () => {
    process.env[TEST_KEY] = 'value'
    restoreEnv(TEST_KEY, 'restored')
    restoreEnv(TEST_KEY, 'restored')
    assert.equal(process.env[TEST_KEY], 'restored')
  })
})

// ── Part 2: Refactored coupling tests using helpers ─────────────────────────
// These mirror the original tests in buildInfoIdempotencyServerCoupling.test.js
// but use saveEnv/restoreEnv instead of the duplicated 5-line pattern.

describe('idempotency guard is per-app — refactored with helpers (issue #344)', { timeout: 10000 }, () => {
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
    try {
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
    } finally {
      restoreEnv(ENV_KEY, savedSha)
    }
  })

  it('env change is reflected on both servers simultaneously', { timeout: 5000 }, async () => {
    try {
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
    } finally {
      restoreEnv(ENV_KEY, savedSha)
    }
  })
})

describe('re-registration on same app — refactored with helpers (issue #344)', { timeout: 10000 }, () => {
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

  it('route still works after idempotent re-registration', { timeout: 5000 }, async () => {
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
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })
})

describe('env var read at request time — refactored with helpers (issue #344)', { timeout: 10000 }, () => {
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
    try {
      process.env.GIT_COMMIT_SHA = 'reqtime2222333344445555666677778888999900'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, 'reqtime')
    } finally {
      restoreEnv(ENV_KEY, savedSha)
    }
  })

  it('deleting env after registration returns null', { timeout: 5000 }, async () => {
    try {
      delete process.env.GIT_COMMIT_SHA
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, null)
    } finally {
      restoreEnv(ENV_KEY, savedSha)
    }
  })

  it('multiple env changes between requests all reflected correctly', { timeout: 5000 }, async () => {
    try {
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
    } finally {
      restoreEnv(ENV_KEY, savedSha)
    }
  })
})

describe('fresh app per describe block — refactored with helpers (issue #344)', { timeout: 10000 }, () => {
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
      restoreEnv(ENV_KEY, savedSha)
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

describe('clearing guard allows re-registration — refactored with helpers (issue #344)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('resetting the guard flag and re-registering adds a duplicate handler', () => {
    const app = createApp()
    registerBuildInfoRoute(app)

    app.locals._buildInfoRegistered = false
    registerBuildInfoRoute(app)

    const layers = app._router.stack.filter(
      (layer) => layer.route && layer.route.path === '/api/build-info'
    )
    assert.equal(layers.length, 2,
      'Clearing the guard should allow a second handler to be added')
  })

  it('duplicate handlers still return correct response', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    app.locals._buildInfoRegistered = false
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      process.env.GIT_COMMIT_SHA = 'duphandler_test_sha_234567890abcdef12345'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.commitShort, 'duphand')
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })
})
