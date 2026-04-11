/**
 * Tests for GitHub issue #389:
 *
 * Prove that afterEach-only cleanup is sufficient for env isolation in the
 * Node test runner — no try/finally guards needed.
 *
 * This file contains ONLY the pure unit-style tests (no HTTP servers):
 *   1. afterEach restores env after a normal (passing) test
 *   2. afterEach restores env after a test that mutates env
 *   3. Sequential tests with different env values stay isolated
 *   4. Delete + restore round-trips work via afterEach alone
 *   5. restoreEnv is idempotent (double-call is harmless but noisy)
 *
 * HTTP integration scenarios that previously lived here have been removed —
 * they are already covered by buildInfoIdempotencyServerCoupling.test.js
 * (issue #327). Keeping them here added ~180 lines of duplicate coverage
 * and extra CI time for no additional signal.
 */
import { describe, it, before, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

const ENV_KEY = 'GIT_COMMIT_SHA'

// — afterEach-only cleanup is sufficient for env isolation ——————————————————

describe('afterEach-only cleanup isolates env between tests (issue #389)', { timeout: 2000 }, () => {
  let savedSha

  before(() => {
    savedSha = saveEnv(ENV_KEY)
  })

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('first test sets env to value A — no try/finally', () => {
    process.env.GIT_COMMIT_SHA = 'aaa_first_test_value_000000000000000000'
    assert.equal(process.env.GIT_COMMIT_SHA, 'aaa_first_test_value_000000000000000000')
  })

  it('second test sees restored env, not value A from previous test', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false,
        'GIT_COMMIT_SHA should have been deleted by afterEach since it was originally unset')
    }
  })

  it('third test sets env to value B — confirms isolation from first test', () => {
    process.env.GIT_COMMIT_SHA = 'bbb_third_test_value_111111111111111111'
    assert.equal(process.env.GIT_COMMIT_SHA, 'bbb_third_test_value_111111111111111111')
  })

  it('fourth test again sees restored env, not value B', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false)
    }
  })
})

// — afterEach runs even after env mutation ——————————————————————————————————

describe('afterEach restores env after mutation in test (issue #389)', { timeout: 2000 }, () => {
  let savedSha

  before(() => {
    savedSha = saveEnv(ENV_KEY)
  })

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('mutate env then verify afterEach cleans up', () => {
    process.env.GIT_COMMIT_SHA = 'subtest_throw_value_2222222222222222'
    assert.equal(process.env.GIT_COMMIT_SHA, 'subtest_throw_value_2222222222222222')
  })

  it('env is restored after previous test — proves afterEach suffices', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should restore env between tests')
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false,
        'afterEach should delete env var when original was unset')
    }
  })
})

// — afterEach handles delete-then-restore round-trip ———————————————————————

describe('afterEach restores env after deletion (issue #389)', { timeout: 2000 }, () => {
  let savedSha

  before(() => {
    savedSha = saveEnv(ENV_KEY)
  })

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('deleting GIT_COMMIT_SHA does not persist to next test', () => {
    delete process.env.GIT_COMMIT_SHA
    assert.equal(Object.hasOwn(process.env, ENV_KEY), false)
  })

  it('env is restored after deletion in previous test', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false)
    }
  })
})

// — restoreEnv is idempotent (justifies removing the redundant call) ———————

describe('restoreEnv idempotency — double call is safe but unnecessary (issue #389)', { timeout: 2000 }, () => {
  const TEST_KEY = '__IDEMPOTENT_RESTORE_389__'

  afterEach(() => {
    delete process.env[TEST_KEY]
  })

  it('calling restoreEnv twice with a string value produces same result', () => {
    process.env[TEST_KEY] = 'modified'
    restoreEnv(TEST_KEY, 'original')
    restoreEnv(TEST_KEY, 'original')
    assert.equal(process.env[TEST_KEY], 'original')
  })

  it('calling restoreEnv twice with undefined produces same result', () => {
    process.env[TEST_KEY] = 'should_vanish'
    restoreEnv(TEST_KEY, undefined)
    restoreEnv(TEST_KEY, undefined)
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false)
  })

  it('restoreEnv in finally then afterEach is equivalent to afterEach alone', () => {
    const saved = saveEnv(TEST_KEY)
    process.env[TEST_KEY] = 'mutated'

    // Simulated finally block
    restoreEnv(TEST_KEY, saved)
    const stateAfterFinally = Object.hasOwn(process.env, TEST_KEY)
      ? process.env[TEST_KEY]
      : undefined

    // Simulated afterEach (runs after finally)
    restoreEnv(TEST_KEY, saved)
    const stateAfterAfterEach = Object.hasOwn(process.env, TEST_KEY)
      ? process.env[TEST_KEY]
      : undefined

    assert.equal(stateAfterFinally, stateAfterAfterEach,
      'finally + afterEach should produce the same state as afterEach alone')
  })
})

// — Multiple env keys isolated independently ————————————————————————————————

describe('afterEach isolates multiple env keys independently (issue #389)', { timeout: 2000 }, () => {
  const KEY_A = '__MULTI_KEY_A_389__'
  const KEY_B = '__MULTI_KEY_B_389__'
  let savedA
  let savedB

  before(() => {
    savedA = saveEnv(KEY_A)
    savedB = saveEnv(KEY_B)
  })

  afterEach(() => {
    restoreEnv(KEY_A, savedA)
    restoreEnv(KEY_B, savedB)
  })

  it('mutating two keys does not leak either to the next test', () => {
    process.env[KEY_A] = 'value_a'
    process.env[KEY_B] = 'value_b'
    assert.equal(process.env[KEY_A], 'value_a')
    assert.equal(process.env[KEY_B], 'value_b')
  })

  it('both keys are restored after the previous test', () => {
    assert.equal(Object.hasOwn(process.env, KEY_A), false,
      'KEY_A should have been cleaned up by afterEach')
    assert.equal(Object.hasOwn(process.env, KEY_B), false,
      'KEY_B should have been cleaned up by afterEach')
  })
})

// — saveEnv captures current state accurately —————————————————————————————————

describe('saveEnv captures env state at call time (issue #389)', { timeout: 2000 }, () => {
  const TEST_KEY = '__SAVE_ENV_389__'

  afterEach(() => {
    delete process.env[TEST_KEY]
  })

  it('returns undefined when env var is not set', () => {
    delete process.env[TEST_KEY]
    const saved = saveEnv(TEST_KEY)
    assert.equal(saved, undefined)
  })

  it('returns the current value when env var is set', () => {
    process.env[TEST_KEY] = 'current_value'
    const saved = saveEnv(TEST_KEY)
    assert.equal(saved, 'current_value')
  })

  it('returns empty string when env var is set to empty string', () => {
    process.env[TEST_KEY] = ''
    const saved = saveEnv(TEST_KEY)
    assert.equal(saved, '')
  })

  it('saveEnv does not modify the environment', () => {
    process.env[TEST_KEY] = 'before_save'
    saveEnv(TEST_KEY)
    assert.equal(process.env[TEST_KEY], 'before_save')
  })
})

// — restoreEnv edge cases ———————————————————————————————————————————————————

describe('restoreEnv edge cases (issue #389)', { timeout: 2000 }, () => {
  const TEST_KEY = '__RESTORE_EDGE_389__'

  afterEach(() => {
    delete process.env[TEST_KEY]
  })

  it('restores empty string correctly (does not delete)', () => {
    process.env[TEST_KEY] = 'non_empty'
    restoreEnv(TEST_KEY, '')
    assert.equal(Object.hasOwn(process.env, TEST_KEY), true,
      'env var should exist when restored to empty string')
    assert.equal(process.env[TEST_KEY], '')
  })

  it('restores when key was never set and saved as undefined', () => {
    delete process.env[TEST_KEY]
    const saved = saveEnv(TEST_KEY)
    process.env[TEST_KEY] = 'temporary'
    restoreEnv(TEST_KEY, saved)
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false,
      'env var should be deleted when restoring undefined')
  })

  it('restoring same value is a no-op', () => {
    process.env[TEST_KEY] = 'stable'
    restoreEnv(TEST_KEY, 'stable')
    assert.equal(process.env[TEST_KEY], 'stable')
  })
})
