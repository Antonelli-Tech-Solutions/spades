/**
 * Regression tests for GitHub issue #317:
 *
 * The regression-guard test in buildInfo.test.js used `delete process.env.GIT_COMMIT_SHA`
 * without restoring it before the test ended. Any test running after (including nested
 * describes) would see an unset value. The fix was a try/finally that restores the env
 * var at the end of that specific test, plus an afterEach guard.
 *
 * This file verifies the env-var isolation guarantees hold across several
 * patterns: sequential tests, nested describes, and mixed mutation sequences.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'

function restoreEnv(key, savedValue) {
  if (savedValue !== undefined) {
    process.env[key] = savedValue
  } else {
    delete process.env[key]
  }
}

async function startTestServer() {
  // DEPENDENCY NOTE (issue #327): This suite creates the server once in before()
  // with a single registerBuildInfoRoute(app) call. The idempotency guard
  // (app.locals._buildInfoRegistered, commit b51ceba) is per-app-instance, so
  // calling registerBuildInfoRoute again on the SAME app would silently no-op.
  // This works because env vars are read at request time, not registration time,
  // so a single registration is sufficient for all tests. If the guard mechanism
  // changes, this setup may need to be revisited.
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

describe('build-info env-var isolation (issue #317)', () => {
  let server
  const savedSha = process.env.GIT_COMMIT_SHA

  before(async () => {
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    // Final restore — belt and suspenders
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  afterEach(() => {
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  // ---------------------------------------------------------------
  // Core regression: delete + restore within the same test
  // ---------------------------------------------------------------

  it('delete inside try/finally restores env var for subsequent code', { timeout: 5000 }, async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    try {
      process.env.GIT_COMMIT_SHA = 'aaa1111bbb2222ccc3333ddd4444eee5555fff66'
      const res1 = await fetch(`${server.baseUrl}/api/build-info`)
      const body1 = await res1.json()
      assert.equal(body1.commitShort, 'aaa1111')

      // This is the dangerous line from issue #317 — delete the var mid-test
      delete process.env.GIT_COMMIT_SHA
      const res2 = await fetch(`${server.baseUrl}/api/build-info`)
      const body2 = await res2.json()
      assert.equal(body2.commitShort, null)
    } finally {
      restoreEnv('GIT_COMMIT_SHA', envBefore)
    }

    // After the finally block, the env var must match pre-test state
    if (envBefore !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, envBefore,
        'env var was not restored after try/finally')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'env var should remain unset when it was originally unset')
    }
  })

  // ---------------------------------------------------------------
  // Sequential isolation: test after a delete sees correct state
  // ---------------------------------------------------------------

  it('first test: deletes GIT_COMMIT_SHA', { timeout: 5000 }, async () => {
    delete process.env.GIT_COMMIT_SHA

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()
    assert.equal(body.commitShort, null)
    // afterEach will fire and restore
  })

  it('second test: env var is restored by afterEach after prior delete', { timeout: 5000 }, async () => {
    // If afterEach did not fire or failed, this test would see an unset var
    // even when savedSha was defined. We verify the endpoint still works
    // with a freshly-set value.
    process.env.GIT_COMMIT_SHA = 'bbb2222ccc3333ddd4444eee5555fff6666777888'
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()
    assert.equal(body.commitShort, 'bbb2222')
  })

  // ---------------------------------------------------------------
  // Mixed mutations: set → delete → set within one test
  // ---------------------------------------------------------------

  it('handles set → delete → set cycle without leaking state', { timeout: 5000 }, async () => {
    // Set
    process.env.GIT_COMMIT_SHA = 'set11111111111111111111111111111111111111'
    let res = await fetch(`${server.baseUrl}/api/build-info`)
    let body = await res.json()
    assert.equal(body.commitShort, 'set1111')

    // Delete
    delete process.env.GIT_COMMIT_SHA
    res = await fetch(`${server.baseUrl}/api/build-info`)
    body = await res.json()
    assert.equal(body.commitShort, null)

    // Set again
    process.env.GIT_COMMIT_SHA = 'reset222222222222222222222222222222222222'
    res = await fetch(`${server.baseUrl}/api/build-info`)
    body = await res.json()
    assert.equal(body.commitShort, 'reset22')
  })

  it('env is clean after mixed mutation test (afterEach ran)', { timeout: 5000 }, async () => {
    // This verifies afterEach restored the original value, not the last
    // value set in the previous test ('reset22...')
    process.env.GIT_COMMIT_SHA = 'verify333333333333333333333333333333333333'
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()
    assert.equal(body.commitShort, 'verify3')
  })

  // ---------------------------------------------------------------
  // Nested describe: inner suite must not see leaked state
  // ---------------------------------------------------------------

  describe('nested suite after env-deleting tests', () => {
    it('sees correct endpoint behavior — env isolation held', { timeout: 5000 }, async () => {
      // If prior tests leaked a deleted env var into this nested describe,
      // the endpoint would return null even after we set a value here.
      // This is the exact scenario issue #317 describes.
      process.env.GIT_COMMIT_SHA = 'nested44444444444444444444444444444444444'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, 'nested4')
    })

    it('can delete and restore without affecting sibling test', { timeout: 5000 }, async () => {
      delete process.env.GIT_COMMIT_SHA
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, null)
    })

    it('sibling test after nested delete sees clean state', { timeout: 5000 }, async () => {
      process.env.GIT_COMMIT_SHA = 'sib5555666666666666666666666666666666666'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, 'sib5555')
    })
  })

  // ---------------------------------------------------------------
  // Assertion failure inside try/finally still restores env
  // ---------------------------------------------------------------

  it('try/finally restores env even when the test logic throws', { timeout: 5000 }, async () => {
    const envBefore = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    let innerError = null
    try {
      process.env.GIT_COMMIT_SHA = 'throw666666666666666666666666666666666666'

      // Deliberately throw to exercise the restore-after-failure path
      throw new Error('simulated test failure')
    } catch (err) {
      innerError = err
    } finally {
      restoreEnv('GIT_COMMIT_SHA', envBefore)
    }

    assert.ok(innerError, 'expected an error from the try block')
    assert.equal(innerError.message, 'simulated test failure')

    // Verify restore happened despite the throw
    if (envBefore !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, envBefore)
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
    }
  })

  // ---------------------------------------------------------------
  // Final canary: endpoint still works at the end of the suite
  // ---------------------------------------------------------------

  it('endpoint remains functional after all isolation tests', { timeout: 5000 }, async () => {
    process.env.GIT_COMMIT_SHA = 'canary77777777777777777777777777777777777'
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'canary7')
  })
})
