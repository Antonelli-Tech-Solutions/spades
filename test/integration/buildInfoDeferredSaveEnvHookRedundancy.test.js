/**
 * Regression tests for issue #399:
 *
 * buildInfoIdempotencyAfterHookRedundancy.test.js line 19 calls
 * `saveEnv('GIT_COMMIT_SHA')` at describe-body scope (file-import time).
 * If another test file mutates GIT_COMMIT_SHA before this file's describe
 * callback executes, the saved value is wrong — afterEach and after() hooks
 * then restore to the polluted value instead of the true original.
 *
 * The fix: move saveEnv into the before() hook so it captures the value at
 * suite-start time, consistent with the server setup that also lives in
 * before().
 *
 * These tests verify:
 *   1. The deferred (before-hook) pattern captures GIT_COMMIT_SHA at runtime,
 *      not at describe-registration time
 *   2. The deferred savedSha works correctly with afterEach env restoration
 *   3. The deferred savedSha works correctly with after() fallback restoration
 *   4. The full integration flow (server + env capture in same before hook)
 *      behaves identically to the original for all build-info route tests
 *   5. Simulated cross-file pollution does not corrupt the deferred saved value
 *   6. restoreEnv idempotency holds with the deferred pattern
 *   7. Edge cases (unset, empty, short SHA) work with deferred capture
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

// -- 1. Deferred saveEnv captures runtime value, not registration-time value --

describe('issue #399: deferred saveEnv in before() captures runtime GIT_COMMIT_SHA', { timeout: 10000 }, () => {
  let server
  let baseUrl
  let savedSha

  before(async () => {
    savedSha = saveEnv('GIT_COMMIT_SHA')

    const app = express()
    app.use(express.json())
    registerBuildInfoRoute(app)

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
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

  it('savedSha is assigned by the time tests run (before hook executed)', () => {
    // savedSha should equal whatever GIT_COMMIT_SHA was at before() time
    // (not undefined due to let declaration, which would indicate before() didn't run)
    const currentOriginal = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined
    // After afterEach restores, env should match savedSha
    assert.equal(currentOriginal, savedSha,
      'env should match the value captured in before()')
  })

  it('route reflects mutated GIT_COMMIT_SHA with deferred save', async () => {
    process.env.GIT_COMMIT_SHA = 'aaa1111222233334444555566667777888899990000'
    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'aaa1111')
  })

  it('route reflects a different mutated SHA independently', async () => {
    process.env.GIT_COMMIT_SHA = 'bbb2222333344445555666677778888999900001111'
    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'bbb2222')
  })

  it('afterEach restores env correctly after mutation', async () => {
    // env should be back to savedSha from afterEach of prior test
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should have restored the original value')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'afterEach should have deleted the env var when saved was undefined')
    }
  })
})

// -- 2. Simulated cross-file pollution: deferred pattern is immune ------------

describe('issue #399: deferred saveEnv resists cross-file pollution of GIT_COMMIT_SHA', { timeout: 2000 }, () => {
  const POLLUTION_KEY = 'GIT_COMMIT_SHA'
  let originalValue
  let savedInBefore

  before(() => {
    // Record actual original before any pollution
    originalValue = Object.hasOwn(process.env, POLLUTION_KEY)
      ? process.env[POLLUTION_KEY]
      : undefined

    // Simulate cross-file pollution: a prior test file leaked a bad value
    process.env[POLLUTION_KEY] = 'POLLUTED_VALUE_FROM_PRIOR_FILE'

    // Now clean up the pollution (as a well-behaved test framework would)
    if (originalValue !== undefined) {
      process.env[POLLUTION_KEY] = originalValue
    } else {
      delete process.env[POLLUTION_KEY]
    }

    // NOW capture — this is the deferred pattern from the fix
    savedInBefore = saveEnv(POLLUTION_KEY)
  })

  afterEach(() => {
    restoreEnv(POLLUTION_KEY, savedInBefore)
  })

  after(() => {
    restoreEnv(POLLUTION_KEY, originalValue)
  })

  it('deferred saveEnv captured the clean value, not the polluted one', () => {
    assert.equal(savedInBefore, originalValue,
      'before() hook should capture the value after cleanup, not the pollution')
    assert.notEqual(savedInBefore, 'POLLUTED_VALUE_FROM_PRIOR_FILE',
      'saved value must not be the polluted value')
  })

  it('afterEach restores to clean value after mutation', () => {
    process.env[POLLUTION_KEY] = 'test_mutation_399'
    restoreEnv(POLLUTION_KEY, savedInBefore)

    if (originalValue !== undefined) {
      assert.equal(process.env[POLLUTION_KEY], originalValue)
    } else {
      assert.equal(Object.hasOwn(process.env, POLLUTION_KEY), false)
    }
  })
})

// -- 3. Contrast: describe-scope capture IS vulnerable to pollution -----------

describe('issue #399: describe-scope saveEnv captures polluted GIT_COMMIT_SHA (contrast)', { timeout: 2000 }, () => {
  const CONTRAST_KEY = '__CONTRAST_POLLUTION_399__'

  // Simulate pollution present at describe-registration time
  process.env[CONTRAST_KEY] = 'pollution_at_load_time'
  const descScopeSaved = saveEnv(CONTRAST_KEY)

  let beforeHookSaved

  before(() => {
    // Clean up the pollution before tests run
    delete process.env[CONTRAST_KEY]
    beforeHookSaved = saveEnv(CONTRAST_KEY)
  })

  afterEach(() => {
    restoreEnv(CONTRAST_KEY, beforeHookSaved)
  })

  after(() => {
    delete process.env[CONTRAST_KEY]
  })

  it('describe-scope captured the polluted value', () => {
    assert.equal(descScopeSaved, 'pollution_at_load_time',
      'describe-scope saveEnv froze the polluted value')
  })

  it('before-hook captured the clean value (undefined)', () => {
    assert.equal(beforeHookSaved, undefined,
      'before() hook saveEnv captured clean state after pollution was removed')
  })

  it('the two saved values differ — proving the timing bug', () => {
    assert.notEqual(descScopeSaved, beforeHookSaved,
      'describe-scope and before-hook captures should differ when pollution exists at load time')
  })
})

// -- 4. restoreEnv idempotency with deferred pattern --------------------------

describe('issue #399: restoreEnv idempotency with deferred savedSha', { timeout: 10000 }, () => {
  let server
  let baseUrl
  let savedSha

  before(async () => {
    savedSha = saveEnv('GIT_COMMIT_SHA')

    const app = express()
    app.use(express.json())
    registerBuildInfoRoute(app)

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
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

  it('calling restoreEnv multiple times does not corrupt state', () => {
    process.env.GIT_COMMIT_SHA = 'ddd4444555566667777888899990000111122223333'

    // Simulate afterEach running
    restoreEnv('GIT_COMMIT_SHA', savedSha)
    // Simulate redundant after hook also running
    restoreEnv('GIT_COMMIT_SHA', savedSha)

    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
    }
  })

  it('restoreEnv handles set-to-unset transition with deferred save', () => {
    process.env.GIT_COMMIT_SHA = 'eee5555666677778888999900001111222233334444'
    restoreEnv('GIT_COMMIT_SHA', undefined)
    assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
      'restoreEnv(key, undefined) should delete the env var')
  })

  it('restoreEnv handles unset-to-set transition with deferred save', () => {
    delete process.env.GIT_COMMIT_SHA
    restoreEnv('GIT_COMMIT_SHA', 'original_sha_value_1234567890abcdef')
    assert.equal(process.env.GIT_COMMIT_SHA, 'original_sha_value_1234567890abcdef')
  })
})

// -- 5. Edge cases: unset, empty, short SHA with deferred pattern -------------

describe('issue #399: build-info route edge cases with deferred saveEnv', { timeout: 10000 }, () => {
  let server
  let baseUrl
  let savedSha

  before(async () => {
    savedSha = saveEnv('GIT_COMMIT_SHA')

    const app = express()
    app.use(express.json())
    registerBuildInfoRoute(app)

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
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

  it('route returns null commitShort when GIT_COMMIT_SHA is unset', async () => {
    delete process.env.GIT_COMMIT_SHA

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, null)
  })

  it('route returns null commitShort when GIT_COMMIT_SHA is empty string', async () => {
    process.env.GIT_COMMIT_SHA = ''

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, null)
  })

  it('route truncates SHA to 7 characters for exactly 7-char input', async () => {
    process.env.GIT_COMMIT_SHA = 'abcdefg'

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'abcdefg')
  })

  it('route returns fewer than 7 characters when SHA is shorter', async () => {
    process.env.GIT_COMMIT_SHA = 'abc'

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'abc')
  })

  it('afterEach correctly restores env after each edge case test', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'env should be restored to the deferred saved value')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'env var should be deleted when deferred saved value was undefined')
    }
  })
})

// -- 6. Server setup and env capture coexist in same before() hook ------------

describe('issue #399: server setup and saveEnv coexist in before() hook', { timeout: 10000 }, () => {
  let server
  let baseUrl
  let savedSha
  const KNOWN_SHA = 'fff6666777788889999000011112222333344445555'

  before(async () => {
    // Capture env BEFORE server setup, in the same before() hook
    savedSha = saveEnv('GIT_COMMIT_SHA')

    // Set a known value for deterministic testing
    process.env.GIT_COMMIT_SHA = KNOWN_SHA

    const app = express()
    app.use(express.json())
    registerBuildInfoRoute(app)

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
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

  it('server reads the env value set after saveEnv in the same before hook', async () => {
    // Re-set after afterEach may have restored
    process.env.GIT_COMMIT_SHA = KNOWN_SHA

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'fff6666',
      'route should read the env value set in before() after saveEnv captured original')
  })

  it('savedSha holds the pre-mutation value, not the KNOWN_SHA', () => {
    // savedSha was captured BEFORE we set KNOWN_SHA in before()
    assert.notEqual(savedSha, KNOWN_SHA,
      'saveEnv should have captured the original value, not the test fixture value')
  })

  it('afterEach restores to pre-test original, not the known test SHA', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
    }
  })
})
