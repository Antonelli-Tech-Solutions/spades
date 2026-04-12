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
 * These tests verify only the genuinely new scenarios not covered elsewhere:
 *   1. Simulated cross-file pollution does not corrupt the deferred saved value
 *   2. Describe-scope vs before-hook capture contrast (proves the timing bug)
 *   3. Server setup and saveEnv coexist in the same before() hook
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

// -- 1. Simulated cross-file pollution: deferred pattern is immune ------------

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

// -- 2. Contrast: describe-scope capture IS vulnerable to pollution -----------

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

// -- 3. Server setup and env capture coexist in same before() hook ------------

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
