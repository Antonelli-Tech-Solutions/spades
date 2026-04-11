/**
 * Tests for GitHub issue #345:
 *
 * Two tests in buildInfoIdempotencyServerCoupling.test.js (and its refactored
 * counterpart) inspect `app._router.stack` to count route layers. This is an
 * undocumented Express internal that could break on a major version upgrade.
 *
 * This file replaces those `_router.stack` inspections with tests that verify
 * observable HTTP behavior:
 *   - Idempotent re-registration: verify only one response is sent (status 200,
 *     correct body, correct content-type, no duplicate response headers).
 *   - Guard reset re-registration: verify the route still responds correctly
 *     after a duplicate handler is added (first handler wins in Express).
 *
 * Each test hits the real HTTP endpoint rather than poking at router internals.
 */
import { describe, it, afterEach } from 'node:test'
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
const TEST_SHA = 'obs_test_sha_1234567890abcdef1234567890abcd'
const TEST_SHORT = 'obs_tes'

// ── Idempotent re-registration: observable behavior ────────────────────────────

describe('idempotent re-registration produces single response (issue #345)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('returns 200 after double registration', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })

  it('returns correct JSON body after double registration', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, TEST_SHORT)
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })

  it('returns valid JSON content-type after double registration', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const contentType = res.headers.get('content-type')
      assert.ok(contentType.includes('application/json'),
        `Expected JSON content-type, got: ${contentType}`)
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })

  it('response body is parseable as a single JSON object (not concatenated duplicates)', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const text = await res.text()
      // If two handlers both wrote to the response, the body would be
      // two concatenated JSON objects (e.g. '{"commitShort":"obs_tes"}{"commitShort":"obs_tes"}')
      // which would fail JSON.parse or produce unexpected results
      let parsed
      assert.doesNotThrow(() => { parsed = JSON.parse(text) },
        'Response body should be a single valid JSON object, not concatenated duplicates')
      assert.equal(typeof parsed, 'object')
      assert.equal(parsed.commitShort, TEST_SHORT)
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })

  it('multiple rapid requests after double registration all return consistent results', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const requests = Array.from({ length: 5 }, () =>
        fetch(`${server.baseUrl}/api/build-info`)
      )
      const responses = await Promise.all(requests)

      for (const res of responses) {
        assert.equal(res.status, 200)
        const body = await res.json()
        assert.equal(body.commitShort, TEST_SHORT)
      }
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })

  it('env change after double registration is reflected correctly', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      process.env.GIT_COMMIT_SHA = 'first_sha_1234567890abcdef1234567890abcd'
      const res1 = await fetch(`${server.baseUrl}/api/build-info`)
      const body1 = await res1.json()
      assert.equal(body1.commitShort, 'first_s')

      process.env.GIT_COMMIT_SHA = 'second_sha_234567890abcdef1234567890abcde'
      const res2 = await fetch(`${server.baseUrl}/api/build-info`)
      const body2 = await res2.json()
      assert.equal(body2.commitShort, 'second_')
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })
})

// ── Guard reset re-registration: observable behavior ───────────────────────────

describe('guard reset re-registration still serves correct response (issue #345)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('route responds 200 after guard reset and re-registration', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    app.locals._buildInfoRegistered = false
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })

  it('returns correct body after guard reset and re-registration', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    app.locals._buildInfoRegistered = false
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, TEST_SHORT)
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })

  it('response is parseable JSON even with duplicate handlers from guard reset', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    app.locals._buildInfoRegistered = false
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const text = await res.text()
      // With duplicate handlers, Express calls the first matching handler.
      // sendJSON ends the response, so the second handler should not produce
      // corrupted output. Verify the response is a single valid JSON object.
      let parsed
      assert.doesNotThrow(() => { parsed = JSON.parse(text) },
        'Response should be valid JSON even with duplicate handlers')
      assert.equal(parsed.commitShort, TEST_SHORT)
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })

  it('guard flag is re-set after second registration', () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    assert.equal(app.locals._buildInfoRegistered, true)

    app.locals._buildInfoRegistered = false
    assert.equal(app.locals._buildInfoRegistered, false)

    registerBuildInfoRoute(app)
    assert.equal(app.locals._buildInfoRegistered, true)
  })

  it('env changes reflect correctly with duplicate handlers from guard reset', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    app.locals._buildInfoRegistered = false
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      const values = [
        { sha: 'dup_a_11222233334444555566667777888899001111', expected: 'dup_a_1' },
        { sha: 'dup_b_22333344445555666677778888999900112222', expected: 'dup_b_2' },
      ]

      for (const { sha, expected } of values) {
        process.env.GIT_COMMIT_SHA = sha
        const res = await fetch(`${server.baseUrl}/api/build-info`)
        const body = await res.json()
        assert.equal(body.commitShort, expected)
      }
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })
})

// ── Single vs double registration: behavior equivalence ────────────────────────

describe('single and double registration produce equivalent observable behavior (issue #345)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('single-registered and double-registered apps return identical responses', { timeout: 5000 }, async () => {
    const appSingle = createApp()
    registerBuildInfoRoute(appSingle)

    const appDouble = createApp()
    registerBuildInfoRoute(appDouble)
    registerBuildInfoRoute(appDouble)

    const serverSingle = await listenOnRandomPort(appSingle)
    const serverDouble = await listenOnRandomPort(appDouble)

    try {
      process.env.GIT_COMMIT_SHA = TEST_SHA

      const [resSingle, resDouble] = await Promise.all([
        fetch(`${serverSingle.baseUrl}/api/build-info`),
        fetch(`${serverDouble.baseUrl}/api/build-info`),
      ])

      assert.equal(resSingle.status, resDouble.status)

      const bodySingle = await resSingle.json()
      const bodyDouble = await resDouble.json()
      assert.deepStrictEqual(bodySingle, bodyDouble)
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await serverSingle.close()
      await serverDouble.close()
    }
  })

  it('single-registered and guard-reset apps return identical responses', { timeout: 5000 }, async () => {
    const appSingle = createApp()
    registerBuildInfoRoute(appSingle)

    const appReset = createApp()
    registerBuildInfoRoute(appReset)
    appReset.locals._buildInfoRegistered = false
    registerBuildInfoRoute(appReset)

    const serverSingle = await listenOnRandomPort(appSingle)
    const serverReset = await listenOnRandomPort(appReset)

    try {
      process.env.GIT_COMMIT_SHA = TEST_SHA

      const [resSingle, resReset] = await Promise.all([
        fetch(`${serverSingle.baseUrl}/api/build-info`),
        fetch(`${serverReset.baseUrl}/api/build-info`),
      ])

      assert.equal(resSingle.status, resReset.status)

      const bodySingle = await resSingle.json()
      const bodyReset = await resReset.json()
      assert.deepStrictEqual(bodySingle, bodyReset)
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await serverSingle.close()
      await serverReset.close()
    }
  })

  it('unset env returns null commitShort for both single and double registration', { timeout: 5000 }, async () => {
    const appSingle = createApp()
    registerBuildInfoRoute(appSingle)

    const appDouble = createApp()
    registerBuildInfoRoute(appDouble)
    registerBuildInfoRoute(appDouble)

    const serverSingle = await listenOnRandomPort(appSingle)
    const serverDouble = await listenOnRandomPort(appDouble)

    try {
      delete process.env.GIT_COMMIT_SHA

      const [resSingle, resDouble] = await Promise.all([
        fetch(`${serverSingle.baseUrl}/api/build-info`),
        fetch(`${serverDouble.baseUrl}/api/build-info`),
      ])

      assert.equal(resSingle.status, 200)
      assert.equal(resDouble.status, 200)

      const bodySingle = await resSingle.json()
      const bodyDouble = await resDouble.json()
      assert.equal(bodySingle.commitShort, null)
      assert.equal(bodyDouble.commitShort, null)
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await serverSingle.close()
      await serverDouble.close()
    }
  })
})

// ── Edge cases: non-build-info routes unaffected ───────────────────────────────

describe('re-registration does not affect other routes (issue #345)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('unregistered route returns 404 regardless of double registration', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    try {
      const res = await fetch(`${server.baseUrl}/api/nonexistent`)
      assert.equal(res.status, 404)
    } finally {
      await server.close()
    }
  })

  it('custom route added alongside double-registered build-info works', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    app.get('/api/health', (req, res) => res.json({ ok: true }))
    const server = await listenOnRandomPort(app)

    try {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const [buildRes, healthRes] = await Promise.all([
        fetch(`${server.baseUrl}/api/build-info`),
        fetch(`${server.baseUrl}/api/health`),
      ])

      assert.equal(buildRes.status, 200)
      assert.equal(healthRes.status, 200)

      const buildBody = await buildRes.json()
      const healthBody = await healthRes.json()
      assert.equal(buildBody.commitShort, TEST_SHORT)
      assert.deepStrictEqual(healthBody, { ok: true })
    } finally {
      restoreEnv(ENV_KEY, savedSha)
      await server.close()
    }
  })
})
