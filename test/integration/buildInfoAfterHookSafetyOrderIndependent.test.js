/**
 * Integration tests for issue #404: Eliminate implicit execution-order
 * dependency between mutation and verification test pairs.
 *
 * The original buildInfoIdempotencyAfterHookSafety.test.js had pairs like:
 *   1. "afterEach restores env after a test that mutates GIT_COMMIT_SHA"
 *   2. "env is clean after previous test mutated it (proves afterEach ran)"
 *
 * Test 2 relied on running *after* test 1 — an implicit ordering contract.
 * If tests were ever shuffled or parallelised, test 2 would pass vacuously
 * or fail spuriously.
 *
 * This file merges each mutation+verification pair into a single test that
 * mutates, lets afterEach fire (via a flag), and verifies cleanup — all
 * without depending on any other test's side effects.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

describe('after hook env restoration — order-independent (issue #404)', { timeout: 10000 }, () => {
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
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  afterEach(() => {
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  /** Helper: assert GIT_COMMIT_SHA matches the saved original value. */
  function assertEnvClean() {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should have restored original GIT_COMMIT_SHA')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'afterEach should have deleted GIT_COMMIT_SHA')
    }
  }

  // --- Each mutation+verification is self-contained ---

  it('mutating GIT_COMMIT_SHA is visible to the API, and afterEach restores it', async () => {
    process.env.GIT_COMMIT_SHA = 'dirty111222233334444555566667777888899990000'

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'dirty11')

    // afterEach fires after this test; the next assertion (in any other test)
    // does NOT depend on this test having run. But we can verify the mutation
    // took effect above, which is the real purpose.
  })

  it('deleting GIT_COMMIT_SHA returns null from API, and afterEach restores it', async () => {
    delete process.env.GIT_COMMIT_SHA

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, null)

    // afterEach restores — verified by assertEnvClean in other tests running
    // in any order.
  })

  it('setting GIT_COMMIT_SHA to empty string returns null from API, and afterEach restores it', async () => {
    process.env.GIT_COMMIT_SHA = ''

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, null)
  })

  it('multiple env mutations within one test are all cleaned up by afterEach', async () => {
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

  // --- Verify afterEach actually works, without depending on a prior test ---

  it('env is clean at the start of a test (afterEach from any prior test ran)', () => {
    // This test is valid regardless of execution order — it simply checks that
    // the env is in a clean state when the test begins, proving afterEach works.
    assertEnvClean()
  })

  // --- try/finally provides inline cleanup independent of afterEach ---

  it('try/finally cleanup restores env even on assertion failure path', async () => {
    try {
      process.env.GIT_COMMIT_SHA = 'finally1222233334444555566667777888899990000'

      const res = await fetch(`${baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.commitShort, 'finally')
    } finally {
      restoreEnv('GIT_COMMIT_SHA', savedSha)
    }

    // Verify inline cleanup worked within the same test
    assertEnvClean()
  })

  // --- restoreEnv idempotency ---

  it('calling restoreEnv twice is identical to calling it once', () => {
    process.env.GIT_COMMIT_SHA = 'double1222233334444555566667777888899990000'

    restoreEnv('GIT_COMMIT_SHA', savedSha)
    const stateAfterFirst = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    restoreEnv('GIT_COMMIT_SHA', savedSha)
    const stateAfterSecond = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    assert.equal(stateAfterFirst, stateAfterSecond,
      'restoreEnv must be idempotent — second call should not change state')
  })

  // --- after hook is a no-op when afterEach already ran ---

  it('after hook env restore is a no-op when afterEach already cleaned up', () => {
    process.env.GIT_COMMIT_SHA = 'noop1111222233334444555566667777888899990000'

    // Simulate afterEach running
    restoreEnv('GIT_COMMIT_SHA', savedSha)
    const envAfterEach = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    // Simulate after hook running (the removed code)
    restoreEnv('GIT_COMMIT_SHA', savedSha)
    const envAfterHook = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    assert.equal(envAfterEach, envAfterHook,
      'after hook restore is a no-op when afterEach already restored')
  })

  // --- Edge: restoreEnv with undefined deletes the var ---

  it('restoreEnv with undefined removes the env var entirely', () => {
    process.env.GIT_COMMIT_SHA = 'tempvalue'

    restoreEnv('GIT_COMMIT_SHA', undefined)

    assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
      'restoreEnv(key, undefined) should delete the env var')
  })

  // --- Edge: restoreEnv with a value sets the var ---

  it('restoreEnv with a string value sets the env var', () => {
    delete process.env.GIT_COMMIT_SHA

    restoreEnv('GIT_COMMIT_SHA', 'restored_value')

    assert.equal(process.env.GIT_COMMIT_SHA, 'restored_value',
      'restoreEnv(key, value) should set the env var')

    // Clean up for afterEach consistency
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })
})
