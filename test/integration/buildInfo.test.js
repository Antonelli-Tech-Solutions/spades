/**
 * Integration tests for the GET /api/build-info endpoint.
 * No database or Redis required — the endpoint is unauthenticated and stateless.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { withEnv } from '../helpers/envHelper.js'

async function startTestServer() {
  const app = express()
  app.use(express.json())

  // Mirror the global CORS middleware from app.js so tests verify real behavior
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, x-session-id, x-player-id, x-table-id',
    )
    if (req.method === 'OPTIONS') {
      return res.status(204).end()
    }
    next()
  })

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

  // ENV-VAR COUPLING: handler must read process.env on each request (issue #306).
  // The "reflects env var changes between requests" regression test guards this.
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
    await withEnv('GIT_COMMIT_SHA', async () => {
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
    })
  })

  // Proves the regression guard above does not pollute env state (issue #316).
  // This test would fail if the finally block were missing and the regression
  // test left GIT_COMMIT_SHA deleted.
  // Uses save/try/finally for self-contained cleanup (issue #324) instead of
  // relying solely on afterEach — consistent with the pattern established by
  // the regression guard test above.
  it('env state is clean after the regression guard test runs', async () => {
    await withEnv('GIT_COMMIT_SHA', async () => {
      assert.notEqual(
        process.env.GIT_COMMIT_SHA,
        '9990000888aaabbbcccdddeeefffaaa111222333'
      )
      // Set a known value, make a request, verify the endpoint still works
      process.env.GIT_COMMIT_SHA = 'clean123check456'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, 'clean12')
    })
  })

  // Self-contained leak-detection test (issue #339): explicitly runs the
  // clean-check scenario inline so it does not depend on test ordering,
  // parallel execution, or --grep filtering.
  it('GIT_COMMIT_SHA is not leaked by the clean-check test', async () => {
    await withEnv('GIT_COMMIT_SHA', async () => {
      // --- Reproduce the clean-check scenario inline ---
      const innerBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
        ? process.env.GIT_COMMIT_SHA
        : undefined
      await withEnv('GIT_COMMIT_SHA', async () => {
        process.env.GIT_COMMIT_SHA = 'clean123check456'
        const res = await fetch(`${server.baseUrl}/api/build-info`)
        const body = await res.json()
        assert.equal(body.commitShort, 'clean12')
      })

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
    })
  })

  // Verifies that the try/finally pattern correctly restores GIT_COMMIT_SHA
  // even when an assertion inside the try block would fail (issue #324).
  // This guards against the case where cleanup only works on the happy path.
  it('try/finally cleanup restores env even after modifications within the block', async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined
    await withEnv('GIT_COMMIT_SHA', async () => {
      // Modify env, use it, then withEnv restores automatically
      process.env.GIT_COMMIT_SHA = 'tryfinallypattern1234567890abcdef12345678'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, 'tryfina')

      // Modify again within the same block
      process.env.GIT_COMMIT_SHA = 'secondvalue567890abcdef1234567890abcdef12'
      const res2 = await fetch(`${server.baseUrl}/api/build-info`)
      const body2 = await res2.json()
      assert.equal(body2.commitShort, 'secondv')
    })
    // After withEnv, env should be back to what it was before the test
    if (envBefore !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, envBefore)
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
    }
  })

  // Issue #340: the previous test here was tautological — it inlined cleanup
  // logic in the try block and asserted on that copy rather than the finally
  // block. Real finally-block cleanup tests live in buildInfoFinallyCleanup.test.js.

  // Issue #309: verify CORS headers are applied to /api/build-info via global middleware
  it('includes CORS headers in the response', async () => {
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.ok(res.headers.get('access-control-allow-methods').includes('GET'))
    assert.ok(res.headers.get('access-control-allow-headers').includes('x-session-id'))
  })

  it('responds to preflight OPTIONS request with 204', async () => {
    const res = await fetch(`${server.baseUrl}/api/build-info`, {
      method: 'OPTIONS',
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  })
})
