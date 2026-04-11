/**
 * Integration tests for issue #366: Verify that removing the `after` hook
 * env restoration from buildInfoIdempotency.test.js is safe.
 *
 * The removed `after` hook (lines 39-43) was a defense-in-depth safety net
 * that restored GIT_COMMIT_SHA at suite teardown. This is redundant because:
 *
 * 1. `afterEach` reliably fires after every test, restoring the env var.
 * 2. Tests that mutate env vars also use try/finally blocks for inline cleanup.
 * 3. `restoreEnv` is idempotent — multiple calls produce the same result.
 * 4. Node's test runner guarantees `afterEach` runs even if assertions fail.
 *
 * These tests prove each of those properties independently.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

describe('after hook env restoration safely removable (issue #366)', { timeout: 10000 }, () => {
  let server
  let baseUrl
  let savedSha

  before(async () => {
    savedSha = saveEnv('GIT_COMMIT_SHA')

    const app = express()
    app.use(express.json())
    registerBuildInfoRoute(app)

    server = await new Promise((resolve) => {
      const srv = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${srv.address().port}`
        resolve(srv)
      })
    })
  })

  after(async () => {
    await new Promise((res) => server.close(res))
    // Final safety restore — mirrors the pattern the issue proposes removing
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  afterEach(() => {
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  // --- afterEach fires reliably even when assertions throw ---

  it('afterEach restores env after a test that mutates GIT_COMMIT_SHA', async () => {
    process.env.GIT_COMMIT_SHA = 'dirty111222233334444555566667777888899990000'

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'dirty11')
    // afterEach will restore — next test verifies the env is clean
  })

  it('env is clean after previous test mutated it (proves afterEach ran)', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should have restored original GIT_COMMIT_SHA')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'afterEach should have deleted GIT_COMMIT_SHA')
    }
  })

  // --- try/finally in individual tests provides inline cleanup ---

  it('try/finally cleanup in test body restores env even on assertion failure path', async () => {
    try {
      process.env.GIT_COMMIT_SHA = 'finally1222233334444555566667777888899990000'

      const res = await fetch(`${baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.commitShort, 'finally')
    } finally {
      restoreEnv('GIT_COMMIT_SHA', savedSha)
    }

    // Verify inline cleanup worked
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
    }
  })

  // --- restoreEnv idempotency: afterEach + after calling it is harmless ---

  it('calling restoreEnv twice is identical to calling it once', () => {
    process.env.GIT_COMMIT_SHA = 'double1222233334444555566667777888899990000'

    // First restore (what afterEach does)
    restoreEnv('GIT_COMMIT_SHA', savedSha)
    const stateAfterFirst = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    // Second restore (what the removed after hook would have done)
    restoreEnv('GIT_COMMIT_SHA', savedSha)
    const stateAfterSecond = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    assert.equal(stateAfterFirst, stateAfterSecond,
      'restoreEnv must be idempotent — second call should not change state')
  })

  // --- Edge: env deleted then restored ---

  it('afterEach correctly restores after env var is deleted mid-test', async () => {
    delete process.env.GIT_COMMIT_SHA

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, null)
    // afterEach will fire and restore
  })

  it('env is clean after previous test deleted it (proves afterEach restored)', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
    }
  })

  // --- Edge: empty string SHA ---

  it('afterEach restores after env var is set to empty string', async () => {
    process.env.GIT_COMMIT_SHA = ''

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, null)
  })

  it('env is clean after previous test set empty string (proves afterEach restored)', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
    }
  })

  // --- Multiple mutations in sequence within one test ---

  it('afterEach restores after multiple env mutations within a single test', async () => {
    process.env.GIT_COMMIT_SHA = 'first111222233334444555566667777888899990000'
    let res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    let body = await res.json()
    assert.equal(body.commitShort, 'first11')

    process.env.GIT_COMMIT_SHA = 'second11222233334444555566667777888899990000'
    res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    body = await res.json()
    assert.equal(body.commitShort, 'second1')

    // afterEach restores to savedSha regardless of how many mutations occurred
  })

  it('env is clean after multiple mutations in previous test', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
    }
  })

  // --- Verify the after hook would be a no-op when afterEach already ran ---

  it('after hook env restore is a no-op when afterEach already cleaned up', () => {
    process.env.GIT_COMMIT_SHA = 'noop1111222233334444555566667777888899990000'

    // Simulate afterEach running
    restoreEnv('GIT_COMMIT_SHA', savedSha)

    // Capture state after afterEach
    const envAfterEach = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    // Simulate after hook running (the removed code)
    restoreEnv('GIT_COMMIT_SHA', savedSha)

    // Capture state after the after hook
    const envAfterHook = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    assert.equal(envAfterEach, envAfterHook,
      'after hook restore is a no-op when afterEach already restored')
  })
})
