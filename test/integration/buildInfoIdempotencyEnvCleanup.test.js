/**
 * Regression tests for GitHub issue #320 / trimmed per issue #334:
 *
 * The original buildInfoIdempotency.test.js set process.env.GIT_COMMIT_SHA
 * but only cleaned it up in the happy path. If fetch() or an assertion threw,
 * the env var leaked into subsequent tests.
 *
 * These three essential regression tests verify:
 *   1. Env var does not leak across tests (isolation)
 *   2. Fresh-app server is cleaned up after use
 *   3. afterEach guard restores env vars even without try/finally
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

async function startTestServer() {
  const app = express()
  app.use(express.json())
  registerBuildInfoRoute(app)

  const server = await new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv))
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return { server, baseUrl }
}

describe('idempotency test env-var cleanup (issue #320)', { timeout: 10000 }, () => {
  let server
  let baseUrl
  const savedSha = saveEnv('GIT_COMMIT_SHA')

  before(async () => {
    ({ server, baseUrl } = await startTestServer())
  })

  after(async () => {
    await new Promise((res) => server.close(res))
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  afterEach(() => {
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  // (1) Env var does not leak across tests
  it('env var set in one test does not leak into the next', async () => {
    // First request: set a known SHA and verify
    process.env.GIT_COMMIT_SHA = 'aaaaaa1234567890abcdef1234567890abcdef12'
    const res1 = await fetch(`${baseUrl}/api/build-info`)
    assert.equal((await res1.json()).commitShort, 'aaaaaa1')

    // afterEach will restore. Simulate the "next test" by restoring now
    // and setting a different SHA — if the first leaked, this would conflict.
    restoreEnv('GIT_COMMIT_SHA', savedSha)
    process.env.GIT_COMMIT_SHA = 'bbbbbb1234567890abcdef1234567890abcdef12'
    const res2 = await fetch(`${baseUrl}/api/build-info`)
    assert.equal((await res2.json()).commitShort, 'bbbbbb1',
      'second request must see the new SHA, not a leaked value')
  })

  // (2) Fresh-app server is cleaned up after use
  it('fresh-app server is properly closed after test', async () => {
    const envBefore = saveEnv('GIT_COMMIT_SHA')

    const { server: freshServer, baseUrl: freshUrl } = await startTestServer()

    try {
      process.env.GIT_COMMIT_SHA = 'freshap1234567890abcdef1234567890abcdef12'

      const res = await fetch(`${freshUrl}/api/build-info`)
      assert.equal(res.status, 200)
      assert.equal((await res.json()).commitShort, 'freshap')
    } finally {
      restoreEnv('GIT_COMMIT_SHA', envBefore)
      await new Promise((res) => freshServer.close(res))
    }

    // Server should be closed — address() returns null after close
    assert.equal(freshServer.address(), null,
      'fresh server should be closed after try/finally cleanup')
  })

  // (3) afterEach guard restores env var even without try/finally
  it('afterEach guard restores env var when test omits try/finally', async () => {
    // Deliberately use the buggy pattern: set env var, do NOT clean up
    process.env.GIT_COMMIT_SHA = 'leaky_1234567890abcdef1234567890abcdef1234'

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal((await res.json()).commitShort, 'leaky_1')

    // NOT cleaning up — afterEach must handle it
  })

  it('env var is restored after test that relied on afterEach', () => {
    // Verify the afterEach from the previous test actually fired
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should have restored the original value')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'afterEach should have deleted the env var')
    }
  })
})
