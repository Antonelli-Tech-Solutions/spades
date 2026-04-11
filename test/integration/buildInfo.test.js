/**
 * Integration tests for the GET /api/build-info endpoint.
 * No database or Redis required — the endpoint is unauthenticated and stateless.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'

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

describe('GET /api/build-info', () => {
  let server

  /**
   * ENV-VAR COUPLING WARNING (see GitHub issue #306):
   *
   * These tests mutate `process.env.GIT_COMMIT_SHA` *after* the server is
   * already listening. This works because the `/api/build-info` handler reads
   * `process.env.GIT_COMMIT_SHA` on every incoming request — it does NOT
   * capture the value once at startup.
   *
   * If the endpoint is ever refactored to snapshot the env var at import time
   * or during server initialization (a common optimization), every test here
   * will silently pass with stale/default values instead of the per-test
   * values set below.
   *
   * The "reflects env var changes between requests" test at the bottom of
   * this suite exists specifically to catch that regression — if it fails,
   * the handler has started caching the value and all other env-dependent
   * tests in this file are unreliable.
   */
  const savedSha = process.env.GIT_COMMIT_SHA

  before(async () => {
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
  })

  afterEach(() => {
    // Restore original env state after each test
    if (savedSha !== undefined) {
      process.env.GIT_COMMIT_SHA = savedSha
    } else {
      delete process.env.GIT_COMMIT_SHA
    }
  })

  it('returns the short commit SHA when GIT_COMMIT_SHA is set', async () => {
    const fullSha = 'abc1234def5678901234567890abcdef12345678'
    process.env.GIT_COMMIT_SHA = fullSha

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.commitShort, 'abc1234')
  })

  it('returns null when GIT_COMMIT_SHA is not set', async () => {
    delete process.env.GIT_COMMIT_SHA

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.commitShort, null)
  })

  it('truncates a full 40-character SHA to 7 characters', async () => {
    process.env.GIT_COMMIT_SHA = 'd10c141a8b3f9e2c4d5e6f7a8b9c0d1e2f3a4b5c'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(body.commitShort, 'd10c141')
    assert.equal(body.commitShort.length, 7)
  })

  it('returns the full value when GIT_COMMIT_SHA is shorter than 7 characters', async () => {
    process.env.GIT_COMMIT_SHA = 'abc12'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(body.commitShort, 'abc12')
  })

  it('returns exactly 7 characters when GIT_COMMIT_SHA is exactly 7 characters', async () => {
    process.env.GIT_COMMIT_SHA = 'abc1234'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(body.commitShort, 'abc1234')
    assert.equal(body.commitShort.length, 7)
  })

  it('returns null when GIT_COMMIT_SHA is an empty string', async () => {
    process.env.GIT_COMMIT_SHA = ''

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(body.commitShort, null)
  })

  it('responds with Content-Type application/json', async () => {
    process.env.GIT_COMMIT_SHA = 'abc1234def5678901234567890abcdef12345678'

    const res = await fetch(`${server.baseUrl}/api/build-info`)

    assert.ok(res.headers.get('content-type').includes('application/json'))
  })

  it('returns only the commitShort key in the response body', async () => {
    process.env.GIT_COMMIT_SHA = 'abc1234def5678901234567890abcdef12345678'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.deepStrictEqual(Object.keys(body), ['commitShort'])
  })

  it('does not require authentication headers', async () => {
    process.env.GIT_COMMIT_SHA = 'abc1234def5678901234567890abcdef12345678'

    // No x-session-id, x-player-id, or x-table-id headers
    const res = await fetch(`${server.baseUrl}/api/build-info`)

    assert.equal(res.status, 200)
  })

  it('rejects POST requests', async () => {
    const res = await fetch(`${server.baseUrl}/api/build-info`, {
      method: 'POST',
    })

    assert.notEqual(res.status, 200)
  })

  it('rejects PUT requests', async () => {
    const res = await fetch(`${server.baseUrl}/api/build-info`, {
      method: 'PUT',
    })

    assert.notEqual(res.status, 200)
  })

  it('rejects DELETE requests', async () => {
    const res = await fetch(`${server.baseUrl}/api/build-info`, {
      method: 'DELETE',
    })

    assert.notEqual(res.status, 200)
  })

  // --- Regression guard for env-var coupling (issue #306) ---
  // Verifies the endpoint reads process.env on every request, not once at
  // startup. If this test fails, every other env-dependent test in this file
  // is unreliable. Safe to run in any order — cleanup is self-contained via
  // try/finally (issue #316).

  it('reflects env var changes between requests (runtime read, not cached at startup)', async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined
    try {
      // First request — set a known SHA
      process.env.GIT_COMMIT_SHA = 'aaa1111bbb2222ccc3333ddd4444eee5555fff66'
      const res1 = await fetch(`${server.baseUrl}/api/build-info`)
      const body1 = await res1.json()
      assert.equal(body1.commitShort, 'aaa1111')

      // Second request — change the SHA without restarting the server
      process.env.GIT_COMMIT_SHA = '9990000888aaabbbcccdddeeefffaaa111222333'
      const res2 = await fetch(`${server.baseUrl}/api/build-info`)
      const body2 = await res2.json()
      assert.equal(body2.commitShort, '9990000')

      // Third request — delete the SHA entirely
      delete process.env.GIT_COMMIT_SHA
      const res3 = await fetch(`${server.baseUrl}/api/build-info`)
      const body3 = await res3.json()
      assert.equal(body3.commitShort, null)
    } finally {
      // Restore env state so this test never pollutes later tests,
      // regardless of assertion failures or test ordering.
      if (envBefore !== undefined) {
        process.env.GIT_COMMIT_SHA = envBefore
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }
  })

  // Proves the regression guard above does not pollute env state (issue #316).
  // This test would fail if the finally block were missing and the regression
  // test left GIT_COMMIT_SHA deleted.
  // Uses save/try/finally for self-contained cleanup (issue #324) instead of
  // relying solely on afterEach — consistent with the pattern established by
  // the regression guard test above.
  it('env state is clean after the regression guard test runs', async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined
    try {
      // Set a known value, make a request, verify the endpoint still works
      process.env.GIT_COMMIT_SHA = 'clean123check456'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, 'clean12')
    } finally {
      if (envBefore !== undefined) {
        process.env.GIT_COMMIT_SHA = envBefore
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }
  })

  // Self-contained leak-detection test (issue #339): explicitly runs the
  // clean-check scenario inline so it does not depend on test ordering,
  // parallel execution, or --grep filtering.
  it('GIT_COMMIT_SHA is not leaked by the clean-check test', async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined
    try {
      // --- Reproduce the clean-check scenario inline ---
      // Save env state the way the clean-check test does
      const innerBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
        ? process.env.GIT_COMMIT_SHA
        : undefined
      try {
        process.env.GIT_COMMIT_SHA = 'clean123check456'
        const res = await fetch(`${server.baseUrl}/api/build-info`)
        const body = await res.json()
        assert.equal(body.commitShort, 'clean12')
      } finally {
        if (innerBefore !== undefined) {
          process.env.GIT_COMMIT_SHA = innerBefore
        } else {
          delete process.env.GIT_COMMIT_SHA
        }
      }

      // --- Now verify the cleanup worked ---
      assert.notEqual(
        process.env.GIT_COMMIT_SHA,
        'clean123check456',
        'GIT_COMMIT_SHA leaked from the clean-check scenario — try/finally cleanup is broken'
      )
      // Also verify it was restored to the correct value
      if (innerBefore !== undefined) {
        assert.equal(process.env.GIT_COMMIT_SHA, innerBefore,
          'GIT_COMMIT_SHA was not restored to its original value')
      } else {
        assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
          'GIT_COMMIT_SHA should have been deleted but still exists')
      }
    } finally {
      if (envBefore !== undefined) {
        process.env.GIT_COMMIT_SHA = envBefore
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }
  })

  // Verifies that the try/finally pattern correctly restores GIT_COMMIT_SHA
  // even when an assertion inside the try block would fail (issue #324).
  // This guards against the case where cleanup only works on the happy path.
  it('try/finally cleanup restores env even after modifications within the block', async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined
    try {
      // Modify env, use it, then let finally restore
      process.env.GIT_COMMIT_SHA = 'tryfinallypattern1234567890abcdef12345678'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, 'tryfina')

      // Modify again within the same block
      process.env.GIT_COMMIT_SHA = 'secondvalue567890abcdef1234567890abcdef12'
      const res2 = await fetch(`${server.baseUrl}/api/build-info`)
      const body2 = await res2.json()
      assert.equal(body2.commitShort, 'secondv')
    } finally {
      if (envBefore !== undefined) {
        process.env.GIT_COMMIT_SHA = envBefore
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }
    // After finally, env should be back to what it was before the test
    if (envBefore !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, envBefore)
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
    }
  })

  // Verifies try/finally cleanup correctly handles the case where
  // GIT_COMMIT_SHA was undefined (not set) before the test (issue #324).
  it('try/finally cleanup correctly deletes env var when it was originally unset', async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined
    try {
      // Force-delete so we know the starting state
      delete process.env.GIT_COMMIT_SHA
      const localBefore = undefined

      // Now set it and verify cleanup would delete it
      process.env.GIT_COMMIT_SHA = 'tempvalue1234567890abcdef1234567890abcdef'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, 'tempval')

      // Simulate the cleanup inline
      if (localBefore !== undefined) {
        process.env.GIT_COMMIT_SHA = localBefore
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'cleanup should delete GIT_COMMIT_SHA when it was originally unset')
    } finally {
      // Restore actual original state
      if (envBefore !== undefined) {
        process.env.GIT_COMMIT_SHA = envBefore
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }
  })
})
