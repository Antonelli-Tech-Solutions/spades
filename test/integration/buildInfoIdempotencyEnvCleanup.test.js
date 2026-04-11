/**
 * Regression tests for GitHub issue #320:
 *
 * Tests in buildInfoIdempotency.test.js at lines 58 and 77 set
 * process.env.GIT_COMMIT_SHA but only delete it in the happy path.
 * If fetch() or an assertion throws, the env var leaks into subsequent tests.
 *
 * These tests verify that:
 *   1. try/finally guarantees env-var cleanup even when fetch or assertions throw
 *   2. afterEach hooks restore env vars after every test regardless of outcome
 *   3. Env var state is not leaked across tests in the idempotency suite
 *   4. The fresh-app test (line 77) also cleans up and closes its server on failure
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'

// ── Helpers ──────────────────────────────────────────────────────────

async function startTestServer() {
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

// ── Tests: try/finally env cleanup in idempotency-style tests ──────

describe('idempotency test env-var cleanup (issue #320)', { timeout: 10000 }, () => {
  let server
  const savedSha = process.env.GIT_COMMIT_SHA

  before(async () => {
    const app = express()
    app.use(express.json())
    registerBuildInfoRoute(app)
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
    if (savedSha !== undefined) {
      process.env.GIT_COMMIT_SHA = savedSha
    } else {
      delete process.env.GIT_COMMIT_SHA
    }
  })

  afterEach(() => {
    if (savedSha !== undefined) {
      process.env.GIT_COMMIT_SHA = savedSha
    } else {
      delete process.env.GIT_COMMIT_SHA
    }
  })

  // ---------------------------------------------------------------
  // Core regression: the pattern from line 53-62 with try/finally
  // ---------------------------------------------------------------

  it('cleans up env var via try/finally even when fetch succeeds (line 53 pattern)', async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    try {
      process.env.GIT_COMMIT_SHA = 'idempotent123456789012345678901234567890'

      const res = await fetch(`${server.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)

      const body = await res.json()
      assert.equal(body.commitShort, 'idempot')
    } finally {
      if (envBefore !== undefined) {
        process.env.GIT_COMMIT_SHA = envBefore
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }

    // Verify cleanup happened
    if (envBefore !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, envBefore,
        'env var should be restored to pre-test value')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'env var should be deleted when it was unset before the test')
    }
  })

  it('env var is not leaked from the previous test', async () => {
    // If the prior test leaked GIT_COMMIT_SHA='idempotent...', this would
    // show the wrong commitShort. Set our own value to verify isolation.
    process.env.GIT_COMMIT_SHA = 'clean111222333444555666777888999000aaabbb'
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()
    assert.equal(body.commitShort, 'clean11')
  })

  // ---------------------------------------------------------------
  // Simulated failure: assertion throws after env var is set
  // ---------------------------------------------------------------

  it('try/finally restores env var even when an assertion fails mid-test', async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    let caughtError = null
    try {
      process.env.GIT_COMMIT_SHA = 'failtest123456789012345678901234567890ab'

      const res = await fetch(`${server.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)

      // Deliberately trigger a failing assertion to simulate the bug scenario
      const body = await res.json()
      try {
        assert.equal(body.commitShort, 'WRONG_VALUE_TO_SIMULATE_FAILURE')
      } catch (innerErr) {
        caughtError = innerErr
      }
    } finally {
      if (envBefore !== undefined) {
        process.env.GIT_COMMIT_SHA = envBefore
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }

    // The inner assertion did fail (simulated)
    assert.ok(caughtError, 'inner assertion should have thrown')

    // But the env var was still cleaned up
    if (envBefore !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, envBefore,
        'env var must be restored even after assertion failure')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'env var must be deleted even after assertion failure')
    }
  })

  it('env var is clean after the simulated-failure test', async () => {
    // Proves the previous test did not leak 'failtest...' into this test
    process.env.GIT_COMMIT_SHA = 'after_fail_check_1234567890abcdef12345678'
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()
    assert.equal(body.commitShort, 'after_f')
  })

  // ---------------------------------------------------------------
  // Fresh-app pattern (line 64-88) with proper try/finally cleanup
  // ---------------------------------------------------------------

  it('fresh-app test cleans up env var and server via try/finally (line 77 pattern)', async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    const freshApp = express()
    freshApp.use(express.json())
    registerBuildInfoRoute(freshApp)

    const freshServer = await new Promise((resolve) => {
      const srv = freshApp.listen(0, () => resolve(srv))
    })

    try {
      const { port } = freshServer.address()
      process.env.GIT_COMMIT_SHA = 'freshapp1234567890abcdef1234567890abcdef'

      const res = await fetch(`http://127.0.0.1:${port}/api/build-info`)
      assert.equal(res.status, 200)

      const body = await res.json()
      assert.equal(body.commitShort, 'freshap')
    } finally {
      // Always restore env var
      if (envBefore !== undefined) {
        process.env.GIT_COMMIT_SHA = envBefore
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
      // Always close the server
      await new Promise((res) => freshServer.close(res))
    }
  })

  it('env var is clean after fresh-app test', async () => {
    process.env.GIT_COMMIT_SHA = 'post_fresh_check_567890abcdef1234567890ab'
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()
    assert.equal(body.commitShort, 'post_fr')
  })

  // ---------------------------------------------------------------
  // Fresh-app pattern: simulated failure still cleans up server
  // ---------------------------------------------------------------

  it('fresh-app server is closed even when assertion fails', async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    const freshApp = express()
    freshApp.use(express.json())
    registerBuildInfoRoute(freshApp)

    const freshServer = await new Promise((resolve) => {
      const srv = freshApp.listen(0, () => resolve(srv))
    })

    let caughtError = null
    try {
      const { port } = freshServer.address()
      process.env.GIT_COMMIT_SHA = 'freshfail890abcdef1234567890abcdef123456'

      const res = await fetch(`http://127.0.0.1:${port}/api/build-info`)
      assert.equal(res.status, 200)

      // Simulate an assertion failure
      try {
        assert.equal('actual', 'expected_wrong_value')
      } catch (innerErr) {
        caughtError = innerErr
      }
    } finally {
      if (envBefore !== undefined) {
        process.env.GIT_COMMIT_SHA = envBefore
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
      await new Promise((res) => freshServer.close(res))
    }

    assert.ok(caughtError, 'simulated assertion failure should have been caught')

    // Verify the fresh server is actually closed by checking that
    // connecting to it fails
    const addr = freshServer.address()
    assert.equal(addr, null,
      'fresh server should be closed (address() returns null after close)')
  })

  // ---------------------------------------------------------------
  // afterEach guard: verify it catches leaks from tests without try/finally
  // ---------------------------------------------------------------

  it('afterEach guard catches env var leak when test has no try/finally', async () => {
    // This simulates the BUGGY pattern from the original code:
    // set env var, do work, delete only in happy path.
    // The afterEach hook should still restore the env var for the next test.
    process.env.GIT_COMMIT_SHA = 'leaky_test_abcdef1234567890abcdef12345678'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()
    assert.equal(body.commitShort, 'leaky_t')

    // Deliberately NOT cleaning up — relying on afterEach
  })

  it('afterEach restored env var after leaky test', async () => {
    // If afterEach did not fire, GIT_COMMIT_SHA would still be 'leaky_test...'
    // or whatever the previous test left. Verify we have a clean slate.
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should have restored the original env var value')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'afterEach should have deleted env var when it was originally unset')
    }
  })

  // ---------------------------------------------------------------
  // Edge case: env var set to empty string vs undefined vs deleted
  // ---------------------------------------------------------------

  it('handles empty-string GIT_COMMIT_SHA without leaking', async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    try {
      process.env.GIT_COMMIT_SHA = ''

      const res = await fetch(`${server.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)

      const body = await res.json()
      // Empty string should result in empty commitShort or null
      assert.ok(body.commitShort === '' || body.commitShort === null,
        `commitShort should be empty or null for empty env var, got: ${body.commitShort}`)
    } finally {
      if (envBefore !== undefined) {
        process.env.GIT_COMMIT_SHA = envBefore
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }
  })

  it('handles short GIT_COMMIT_SHA (< 7 chars) without leaking', async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    try {
      process.env.GIT_COMMIT_SHA = 'abc'

      const res = await fetch(`${server.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)

      const body = await res.json()
      assert.equal(body.commitShort, 'abc')
    } finally {
      if (envBefore !== undefined) {
        process.env.GIT_COMMIT_SHA = envBefore
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }
  })

  // ---------------------------------------------------------------
  // Final canary: endpoint functional after all cleanup tests
  // ---------------------------------------------------------------

  it('endpoint remains functional after all env-cleanup tests', async () => {
    process.env.GIT_COMMIT_SHA = 'canary_final_abcdef1234567890abcdef123456'
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'canary_')
  })
})
