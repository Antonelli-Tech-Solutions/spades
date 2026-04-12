/**
 * TDD tests for GitHub issue #333:
 *
 * The 5-line save/restore pattern for environment variables is copy-pasted
 * ~15 times across buildInfoIdempotencyEnvCleanup.test.js and
 * buildInfoEnvIsolation.test.js:
 *
 *   if (savedValue !== undefined) {
 *     process.env[KEY] = savedValue
 *   } else {
 *     delete process.env[KEY]
 *   }
 *
 * This file tests the extracted helpers:
 *   - saveEnv(key)    — captures the current value (or undefined if unset)
 *   - restoreEnv(key, savedValue) — restores or deletes the env var
 *
 * These are pure unit tests with no server or Redis dependency.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { restoreEnv, saveEnv } from '../helpers/envHelper.js'

// Use a dedicated test key to avoid interfering with real env vars
const TEST_KEY = '__RESTORE_ENV_TEST_KEY__'

describe('restoreEnv helper (issue #333)', { timeout: 2000 }, () => {
  // Always clean up the test key after each test
  afterEach(() => {
    delete process.env[TEST_KEY]
  })

  // ---------------------------------------------------------------
  // restoreEnv: core behavior
  // ---------------------------------------------------------------

  it('restores env var to a saved string value', () => {
    process.env[TEST_KEY] = 'modified'
    restoreEnv(TEST_KEY, 'original')
    assert.equal(process.env[TEST_KEY], 'original')
  })

  it('deletes env var when savedValue is undefined', () => {
    process.env[TEST_KEY] = 'should-be-deleted'
    restoreEnv(TEST_KEY, undefined)
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false,
      'env var should be deleted when savedValue is undefined')
  })

  it('restores env var to empty string (not delete)', () => {
    process.env[TEST_KEY] = 'non-empty'
    restoreEnv(TEST_KEY, '')
    assert.equal(process.env[TEST_KEY], '')
    assert.equal(Object.hasOwn(process.env, TEST_KEY), true,
      'env var should exist with empty string value')
  })

  it('is a no-op delete when var is already unset and savedValue is undefined', () => {
    delete process.env[TEST_KEY]
    restoreEnv(TEST_KEY, undefined)
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false)
  })

  it('sets env var from unset state when savedValue is provided', () => {
    delete process.env[TEST_KEY]
    restoreEnv(TEST_KEY, 'was-set-before')
    assert.equal(process.env[TEST_KEY], 'was-set-before')
  })

  it('handles savedValue with special characters', () => {
    restoreEnv(TEST_KEY, 'value=with=equals&special chars\nnewline')
    assert.equal(process.env[TEST_KEY], 'value=with=equals&special chars\nnewline')
  })

  // ---------------------------------------------------------------
  // restoreEnv: works with any key name
  // ---------------------------------------------------------------

  it('works with GIT_COMMIT_SHA (the real use case)', () => {
    const originalSha = process.env.GIT_COMMIT_SHA
    const saved = saveEnv('GIT_COMMIT_SHA')

    try {
      process.env.GIT_COMMIT_SHA = 'test_sha_1234567890abcdef'
      restoreEnv('GIT_COMMIT_SHA', saved)

      if (saved !== undefined) {
        assert.equal(process.env.GIT_COMMIT_SHA, saved)
      } else {
        assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
      }
    } finally {
      // Belt-and-suspenders: manually restore in case test logic fails
      if (originalSha !== undefined) {
        process.env.GIT_COMMIT_SHA = originalSha
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }
  })

  it('works with GIT_BRANCH key', () => {
    const saved = saveEnv('GIT_BRANCH')
    try {
      process.env.GIT_BRANCH = 'test-branch'
      restoreEnv('GIT_BRANCH', saved)

      if (saved !== undefined) {
        assert.equal(process.env.GIT_BRANCH, saved)
      } else {
        assert.equal(Object.hasOwn(process.env, 'GIT_BRANCH'), false)
      }
    } finally {
      if (saved !== undefined) {
        process.env.GIT_BRANCH = saved
      } else {
        delete process.env.GIT_BRANCH
      }
    }
  })

  // ---------------------------------------------------------------
  // saveEnv: captures current state
  // ---------------------------------------------------------------

  describe('saveEnv helper', () => {
    it('returns the current value when env var is set', () => {
      process.env[TEST_KEY] = 'current-value'
      const saved = saveEnv(TEST_KEY)
      assert.equal(saved, 'current-value')
    })

    it('returns undefined when env var is not set', () => {
      delete process.env[TEST_KEY]
      const saved = saveEnv(TEST_KEY)
      assert.equal(saved, undefined)
    })

    it('returns empty string when env var is set to empty string', () => {
      process.env[TEST_KEY] = ''
      const saved = saveEnv(TEST_KEY)
      assert.equal(saved, '')
    })

    it('does not modify the env var', () => {
      process.env[TEST_KEY] = 'should-not-change'
      saveEnv(TEST_KEY)
      assert.equal(process.env[TEST_KEY], 'should-not-change')
    })
  })

  // ---------------------------------------------------------------
  // Round-trip: saveEnv → mutate → restoreEnv
  // ---------------------------------------------------------------

  describe('saveEnv + restoreEnv round-trip', () => {
    it('round-trips a set value through mutation', () => {
      process.env[TEST_KEY] = 'round-trip-original'
      const saved = saveEnv(TEST_KEY)

      process.env[TEST_KEY] = 'mutated'
      restoreEnv(TEST_KEY, saved)

      assert.equal(process.env[TEST_KEY], 'round-trip-original')
    })

    it('round-trips an unset value through mutation', () => {
      delete process.env[TEST_KEY]
      const saved = saveEnv(TEST_KEY)

      process.env[TEST_KEY] = 'temporarily-set'
      restoreEnv(TEST_KEY, saved)

      assert.equal(Object.hasOwn(process.env, TEST_KEY), false,
        'env var should be deleted after round-trip restore')
    })

    it('round-trips through delete and re-set', () => {
      process.env[TEST_KEY] = 'original'
      const saved = saveEnv(TEST_KEY)

      delete process.env[TEST_KEY]
      restoreEnv(TEST_KEY, saved)

      assert.equal(process.env[TEST_KEY], 'original')
    })

    it('round-trips an empty-string value', () => {
      process.env[TEST_KEY] = ''
      const saved = saveEnv(TEST_KEY)

      process.env[TEST_KEY] = 'non-empty'
      restoreEnv(TEST_KEY, saved)

      assert.equal(process.env[TEST_KEY], '')
    })
  })

  // ---------------------------------------------------------------
  // Use in try/finally (the intended pattern)
  // ---------------------------------------------------------------

  describe('try/finally usage pattern', () => {
    it('restores env var after successful block', () => {
      process.env[TEST_KEY] = 'before-try'
      const saved = saveEnv(TEST_KEY)

      try {
        process.env[TEST_KEY] = 'inside-try'
        // Simulate successful work
        assert.equal(process.env[TEST_KEY], 'inside-try')
      } finally {
        restoreEnv(TEST_KEY, saved)
      }

      assert.equal(process.env[TEST_KEY], 'before-try')
    })

    it('restores env var after error in block', () => {
      process.env[TEST_KEY] = 'before-error'
      const saved = saveEnv(TEST_KEY)

      let caughtError = null
      try {
        process.env[TEST_KEY] = 'inside-error-block'
        throw new Error('simulated failure')
      } catch (err) {
        caughtError = err
      } finally {
        restoreEnv(TEST_KEY, saved)
      }

      assert.ok(caughtError, 'error should have been caught')
      assert.equal(process.env[TEST_KEY], 'before-error',
        'env var must be restored even after error')
    })

    it('restores unset env var after error in block', () => {
      delete process.env[TEST_KEY]
      const saved = saveEnv(TEST_KEY)

      let caughtError = null
      try {
        process.env[TEST_KEY] = 'set-then-error'
        throw new Error('simulated failure')
      } catch (err) {
        caughtError = err
      } finally {
        restoreEnv(TEST_KEY, saved)
      }

      assert.ok(caughtError)
      assert.equal(Object.hasOwn(process.env, TEST_KEY), false,
        'env var must be deleted after error when originally unset')
    })
  })

  // ---------------------------------------------------------------
  // Use in afterEach (the other intended pattern)
  // ---------------------------------------------------------------

  describe('afterEach usage pattern', () => {
    // This sub-suite simulates using saveEnv/restoreEnv in afterEach
    const suiteKey = '__AFTER_EACH_TEST_KEY__'
    const suiteSaved = saveEnv(suiteKey)

    afterEach(() => {
      restoreEnv(suiteKey, suiteSaved)
    })

    it('first test: sets the env var', () => {
      process.env[suiteKey] = 'first-test-value'
      assert.equal(process.env[suiteKey], 'first-test-value')
      // afterEach will call restoreEnv
    })

    it('second test: env var was restored by afterEach', () => {
      // If afterEach didn't run, we'd see 'first-test-value'
      if (suiteSaved !== undefined) {
        assert.equal(process.env[suiteKey], suiteSaved)
      } else {
        assert.equal(Object.hasOwn(process.env, suiteKey), false,
          'afterEach should have cleaned up the env var')
      }
    })

    it('third test: sets and deletes, afterEach still restores', () => {
      process.env[suiteKey] = 'third-test'
      delete process.env[suiteKey]
      // afterEach will call restoreEnv
    })

    it('fourth test: confirms third test cleanup', () => {
      if (suiteSaved !== undefined) {
        assert.equal(process.env[suiteKey], suiteSaved)
      } else {
        assert.equal(Object.hasOwn(process.env, suiteKey), false)
      }
    })
  })

  // ---------------------------------------------------------------
  // Multiple env vars: independent restore
  // ---------------------------------------------------------------

  describe('multiple env vars', () => {
    const KEY_A = '__MULTI_TEST_A__'
    const KEY_B = '__MULTI_TEST_B__'

    afterEach(() => {
      delete process.env[KEY_A]
      delete process.env[KEY_B]
    })

    it('restoring one key does not affect another', () => {
      process.env[KEY_A] = 'a-original'
      process.env[KEY_B] = 'b-original'

      const savedA = saveEnv(KEY_A)
      const savedB = saveEnv(KEY_B)

      process.env[KEY_A] = 'a-modified'
      process.env[KEY_B] = 'b-modified'

      restoreEnv(KEY_A, savedA)

      assert.equal(process.env[KEY_A], 'a-original',
        'KEY_A should be restored')
      assert.equal(process.env[KEY_B], 'b-modified',
        'KEY_B should still be modified')

      restoreEnv(KEY_B, savedB)
      assert.equal(process.env[KEY_B], 'b-original')
    })
  })
})
