/**
 * Tests for GitHub issue #345 (refactored per issue #382, cleaned per #385):
 *
 * Verifies observable HTTP behavior of build-info route registration:
 *   - Idempotent re-registration: only one response is sent (status 200,
 *     correct body, correct content-type, no duplicate response).
 *   - Single vs double registration produce equivalent results.
 *   - Re-registration does not affect other routes.
 *
 * Issue #382: extracted duplicated create-app-register-listen-teardown
 * boilerplate into shared helpers; collapsed tests that assert different
 * properties of the same response into single tests.
 *
 * Issue #385: removed guard-reset tests that coupled to the internal
 * `app.locals._buildInfoRegistered` flag.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

// ── Shared helpers (issue #382) ──────────────────────────────────────────────────

function createApp() {
  const app = express()
  app.use(express.json())
  return app
}

function listenOnRandomPort(app) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      const { port } = srv.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => srv.close(res)),
      })
    })
    srv.on('error', (err) => reject(err))
  })
}

/**
 * Create an Express app with build-info route registered `count` times.
 */
function createRegisteredApp({ count = 1 } = {}) {
  const app = createApp()
  for (let i = 0; i < count; i++) {
    registerBuildInfoRoute(app)
  }
  return app
}

/**
 * Set up a server with registered build-info route, run an async callback
 * with the server's baseUrl, then tear down. Handles env save/restore
 * for the given envKey (defaults to GIT_COMMIT_SHA) as a belt-and-suspenders
 * safeguard so that a mid-test assertion failure cannot leak env mutations.
 */
async function withBuildInfoServer(appOpts, fn, { envKey = ENV_KEY } = {}) {
  const saved = saveEnv(envKey)
  const app = createRegisteredApp(appOpts)
  const server = await listenOnRandomPort(app)
  try {
    await fn(server.baseUrl, app)
  } finally {
    await server.close()
    restoreEnv(envKey, saved)
  }
}

/**
 * Set up two servers and run an async callback with both baseUrls,
 * then tear down both.
 */
async function withTwoServers(optsA, optsB, fn) {
  const appA = createRegisteredApp(optsA)
  const appB = createRegisteredApp(optsB)
  const serverA = await listenOnRandomPort(appA)
  const serverB = await listenOnRandomPort(appB)
  try {
    await fn(serverA.baseUrl, serverB.baseUrl)
  } finally {
    await Promise.allSettled([serverA.close(), serverB.close()])
  }
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

  it('returns 200 with correct JSON body and content-type after double registration', { timeout: 5000 }, async () => {
    await withBuildInfoServer({ count: 2 }, async (baseUrl) => {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const res = await fetch(`${baseUrl}/api/build-info`)

      assert.equal(res.status, 200)

      const contentType = res.headers.get('content-type')
      assert.ok(contentType.includes('application/json'),
        `Expected JSON content-type, got: ${contentType}`)

      const body = await res.json()
      assert.equal(body.commitShort, TEST_SHORT)
    })
  })

  it('response body is parseable as a single JSON object (not concatenated duplicates)', { timeout: 5000 }, async () => {
    await withBuildInfoServer({ count: 2 }, async (baseUrl) => {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const res = await fetch(`${baseUrl}/api/build-info`)
      const text = await res.text()
      // If two handlers both wrote to the response, the body would be
      // two concatenated JSON objects which would fail JSON.parse
      let parsed
      assert.doesNotThrow(() => { parsed = JSON.parse(text) },
        'Response body should be a single valid JSON object, not concatenated duplicates')
      assert.equal(typeof parsed, 'object')
      assert.equal(parsed.commitShort, TEST_SHORT)
    })
  })

  it('multiple rapid requests after double registration all return consistent results', { timeout: 5000 }, async () => {
    await withBuildInfoServer({ count: 2 }, async (baseUrl) => {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const requests = Array.from({ length: 5 }, () =>
        fetch(`${baseUrl}/api/build-info`)
      )
      const responses = await Promise.all(requests)

      for (const res of responses) {
        assert.equal(res.status, 200)
        const body = await res.json()
        assert.equal(body.commitShort, TEST_SHORT)
      }
    })
  })

  it('env change after double registration is reflected correctly', { timeout: 5000 }, async () => {
    await withBuildInfoServer({ count: 2 }, async (baseUrl) => {
      process.env.GIT_COMMIT_SHA = 'first_sha_1234567890abcdef1234567890abcd'
      const res1 = await fetch(`${baseUrl}/api/build-info`)
      const body1 = await res1.json()
      assert.equal(body1.commitShort, 'first_s')

      process.env.GIT_COMMIT_SHA = 'second_sha_234567890abcdef1234567890abcde'
      const res2 = await fetch(`${baseUrl}/api/build-info`)
      const body2 = await res2.json()
      assert.equal(body2.commitShort, 'second_')
    })
  })
})

// ── Single vs double registration: behavior equivalence ────────────────────────

describe('single and double registration produce equivalent observable behavior (issue #345)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('single-registered and double-registered apps return identical responses', { timeout: 5000 }, async () => {
    await withTwoServers({ count: 1 }, { count: 2 }, async (singleUrl, doubleUrl) => {
      process.env.GIT_COMMIT_SHA = TEST_SHA

      const [resSingle, resDouble] = await Promise.all([
        fetch(`${singleUrl}/api/build-info`),
        fetch(`${doubleUrl}/api/build-info`),
      ])

      assert.equal(resSingle.status, resDouble.status)

      const bodySingle = await resSingle.json()
      const bodyDouble = await resDouble.json()
      assert.deepStrictEqual(bodySingle, bodyDouble)
    })
  })

  it('unset env returns null commitShort for both single and double registration', { timeout: 5000 }, async () => {
    await withTwoServers({ count: 1 }, { count: 2 }, async (singleUrl, doubleUrl) => {
      delete process.env.GIT_COMMIT_SHA

      const [resSingle, resDouble] = await Promise.all([
        fetch(`${singleUrl}/api/build-info`),
        fetch(`${doubleUrl}/api/build-info`),
      ])

      assert.equal(resSingle.status, 200)
      assert.equal(resDouble.status, 200)

      const bodySingle = await resSingle.json()
      const bodyDouble = await resDouble.json()
      assert.equal(bodySingle.commitShort, null)
      assert.equal(bodyDouble.commitShort, null)
    })
  })
})

// ── Edge cases: non-build-info routes unaffected ───────────────────────────────

describe('re-registration does not affect other routes (issue #345)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('custom route added alongside double-registered build-info works', { timeout: 5000 }, async () => {
    const app = createRegisteredApp({ count: 2 })
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
      await server.close()
    }
  })
})
