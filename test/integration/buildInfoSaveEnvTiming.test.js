/**
 * Tests for GitHub issue #390:
 *
 * saveEnv(ENV_KEY) called at describe-block scope runs at file-load time,
 * before any before/beforeEach hooks. If a prior test file (or an earlier
 * describe block in the same file) mutates the env without cleanup, the
 * saved value captures the polluted state rather than the true original.
 *
 * These tests prove:
 *   1. saveEnv at describe scope captures whatever value exists at load time
 *      (vulnerable to cross-file pollution)
 *   2. saveEnv inside a before() hook captures the value at hook-run time
 *      (correct pattern for deferred capture)
 *   3. saveEnv inside beforeEach() captures fresh state before every test
 *   4. Cross-describe pollution: an earlier describe that leaks env pollutes
 *      a later describe that uses describe-scope saveEnv
 *   5. Cross-describe isolation: a later describe using before()-scoped
 *      saveEnv is immune to earlier describe pollution when cleaned up
 *   6. The deferred pattern (before hook) restores correctly via afterEach
 *   7. Multiple env keys deferred via before() all capture correctly
 *   8. saveEnv at describe scope with undefined env returns undefined
 *      regardless of later mutations
 */
import { describe, it, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

const ENV_KEY = 'GIT_COMMIT_SHA'

// — Describe-scope saveEnv captures load-time value (the problem) ————————————

describe('saveEnv at describe scope captures load-time value (issue #390)', { timeout: 2000 }, () => {
  // This is the problematic pattern: saveEnv runs NOW, at file load time.
  // Whatever GIT_COMMIT_SHA is right now gets captured — it may already be
  // polluted by a prior file in the same process.
  const descScopeSaved = saveEnv(ENV_KEY)
  const loadTimeValue = Object.hasOwn(process.env, ENV_KEY)
    ? process.env[ENV_KEY]
    : undefined

  afterEach(() => {
    restoreEnv(ENV_KEY, descScopeSaved)
  })

  it('describe-scope saveEnv equals the env value at file-load time', () => {
    // The saved value must match what was in the env when the file loaded.
    // This is the expected (but fragile) behavior.
    assert.equal(descScopeSaved, loadTimeValue,
      'saveEnv at describe scope should capture the value present at load time')
  })

  it('describe-scope saveEnv does NOT re-read — it is a frozen snapshot', () => {
    // Mutate env after load
    process.env[ENV_KEY] = 'post_load_mutation_390'
    // The describe-scope saved value is unchanged
    assert.equal(descScopeSaved, loadTimeValue,
      'describe-scope saved value must not change when env is mutated later')
  })
})

// — before() hook defers saveEnv to run-time (the fix) ————————————————————————

describe('saveEnv inside before() hook captures run-time value (issue #390)', { timeout: 2000 }, () => {
  const ISOLATED_KEY = '__BEFORE_HOOK_DEFERRED_390__'
  let savedInBefore

  before(() => {
    // Set a known value, then capture it. This runs at test-execution time,
    // not at file-load time — safe from cross-file pollution.
    process.env[ISOLATED_KEY] = 'known_runtime_value'
    savedInBefore = saveEnv(ISOLATED_KEY)
  })

  afterEach(() => {
    restoreEnv(ISOLATED_KEY, savedInBefore)
  })

  // Final cleanup: remove the key we introduced
  after(() => {
    delete process.env[ISOLATED_KEY]
  })

  it('before-hook saveEnv captures the value set during hook execution', () => {
    assert.equal(savedInBefore, 'known_runtime_value',
      'saveEnv in before() should capture the value at hook-run time')
  })

  it('afterEach restores to the before-hook captured value after mutation', () => {
    // Previous test mutated nothing extra, afterEach ran, now verify:
    assert.equal(process.env[ISOLATED_KEY], 'known_runtime_value',
      'afterEach should restore to the value captured in before()')
  })

  it('mutation within test is cleaned up by afterEach using deferred saved value', () => {
    process.env[ISOLATED_KEY] = 'mutated_in_test_390'
    assert.equal(process.env[ISOLATED_KEY], 'mutated_in_test_390')
    // afterEach will restore to 'known_runtime_value'
  })

  it('confirms restoration after previous mutation', () => {
    assert.equal(process.env[ISOLATED_KEY], 'known_runtime_value',
      'afterEach with deferred saveEnv correctly restores after mutation')
  })
})

// — beforeEach() captures fresh state every test ——————————————————————————————

describe('saveEnv inside beforeEach() captures fresh state per test (issue #390)', { timeout: 2000 }, () => {
  const EACH_KEY = '__BEFORE_EACH_DEFERRED_390__'
  let savedInBeforeEach

  beforeEach(() => {
    savedInBeforeEach = saveEnv(EACH_KEY)
  })

  afterEach(() => {
    restoreEnv(EACH_KEY, savedInBeforeEach)
  })

  it('first test: key is initially unset, saveEnv returns undefined', () => {
    assert.equal(savedInBeforeEach, undefined,
      'beforeEach should capture undefined for unset key')
    // Set it — next beforeEach will see undefined again because afterEach restores
    process.env[EACH_KEY] = 'set_in_first_test'
  })

  it('second test: afterEach restored, so beforeEach captures undefined again', () => {
    assert.equal(savedInBeforeEach, undefined,
      'beforeEach should capture undefined after afterEach cleanup')
  })
})

// — Simulated cross-file pollution (the vulnerability) ————————————————————————
//
// ⚠️  SELF-POLLUTION WARNING (issue #435)
// This describe block intentionally sets process.env at describe scope to
// demonstrate the anti-pattern. That means THIS FILE is itself a pollution
// source for any test file loaded after it in the same process. The after()
// hook cleans up, but if it fails or the runner loads files concurrently the
// key will leak. The key name is intentionally long and unique to avoid
// collisions with any real env var or other test key.

describe('simulated cross-file pollution via describe-scope saveEnv (issue #390)', { timeout: 2000 }, () => {
  const POLLUTE_KEY = '__CROSS_FILE_POLLUTION_390_DEMO_ANTIPATTERN_DO_NOT_REUSE__'

  // Simulate what happens when a prior test file mutates env at load time
  // (e.g. a top-level `process.env[KEY] = ...` or a leaked test mutation).
  // In a real scenario this pollution comes from another file; here we
  // set it before calling saveEnv to simulate the same effect.
  //
  // ⚠️  This runs at file-load time and pollutes process.env for the entire
  //    process until the after() hook below deletes it. See issue #435.
  process.env[POLLUTE_KEY] = 'pollution_from_prior_file'

  // This is the problematic pattern: saveEnv at describe scope captures
  // the polluted value, believing it to be the "original" state.
  const descScopeSaved = saveEnv(POLLUTE_KEY)

  afterEach(() => {
    restoreEnv(POLLUTE_KEY, descScopeSaved)
  })

  after(() => {
    delete process.env[POLLUTE_KEY]
  })

  it('describe-scope saveEnv captured the polluted value as if it were original', () => {
    assert.equal(descScopeSaved, 'pollution_from_prior_file',
      'describe-scope saveEnv captured pollution — it cannot distinguish original from leaked')
  })

  it('afterEach "restores" to the polluted value, not the true original', () => {
    process.env[POLLUTE_KEY] = 'test_mutation'
    // afterEach will restore to 'pollution_from_prior_file' — wrong!
  })

  it('confirms afterEach restored to the polluted value', () => {
    assert.equal(process.env[POLLUTE_KEY], 'pollution_from_prior_file',
      'afterEach restored to the pollution, not the true original (undefined)')
  })
})

// — before()-hook saveEnv avoids the pollution problem ————————————————————————

describe('before()-hook saveEnv with controlled setup avoids pollution (issue #390)', { timeout: 2000 }, () => {
  const CLEAN_KEY = '__CLEAN_BEFORE_HOOK_390__'
  let savedInBefore

  before(() => {
    // In a real fix, the before() hook runs at a well-defined point in
    // the test lifecycle. If prior cleanup ran correctly, this captures
    // the clean state. The key difference: the timing is explicit and
    // predictable, unlike describe-scope which runs at file-load time.
    delete process.env[CLEAN_KEY] // ensure clean state
    savedInBefore = saveEnv(CLEAN_KEY)
  })

  afterEach(() => {
    restoreEnv(CLEAN_KEY, savedInBefore)
  })

  it('before-hook saveEnv captures the clean state (undefined)', () => {
    assert.equal(savedInBefore, undefined,
      'before() hook captured clean state after explicit setup')
  })

  it('mutation is correctly restored to the true original (undefined)', () => {
    process.env[CLEAN_KEY] = 'mutated_clean_test'
    assert.equal(process.env[CLEAN_KEY], 'mutated_clean_test')
  })

  it('confirms restoration to undefined (deleted) — the true original', () => {
    assert.equal(Object.hasOwn(process.env, CLEAN_KEY), false,
      'afterEach restored to undefined — the true original, not a polluted value')
  })
})

// — before()-scoped saveEnv is immune to describe-time capture issues ——————————

describe('before()-scoped saveEnv avoids describe-time capture issue (issue #390)', { timeout: 2000 }, () => {
  const IMMUNE_KEY = '__IMMUNE_BEFORE_HOOK_390__'
  let savedInBefore

  before(() => {
    // Runs after all describes are registered and tests start executing.
    // This captures the actual runtime state, not registration-time state.
    savedInBefore = saveEnv(IMMUNE_KEY)
  })

  afterEach(() => {
    restoreEnv(IMMUNE_KEY, savedInBefore)
  })

  it('before-hook saveEnv captures runtime state, not registration-time state', () => {
    // Whatever IMMUNE_KEY is at test-run time is what we captured.
    // This is resilient to cross-file pollution because at least we capture
    // the value at a well-defined point in the test lifecycle.
    const currentValue = Object.hasOwn(process.env, IMMUNE_KEY)
      ? process.env[IMMUNE_KEY]
      : undefined
    assert.equal(savedInBefore, currentValue,
      'before() hook captures the actual value at test-run time')
  })

  it('mutation is properly restored using before-hook captured value', () => {
    process.env[IMMUNE_KEY] = 'mutated_immune_test'
    assert.equal(process.env[IMMUNE_KEY], 'mutated_immune_test')
    // afterEach restores using savedInBefore
  })

  it('restoration verified after mutation', () => {
    if (savedInBefore !== undefined) {
      assert.equal(process.env[IMMUNE_KEY], savedInBefore)
    } else {
      assert.equal(Object.hasOwn(process.env, IMMUNE_KEY), false,
        'should be deleted when saved value was undefined')
    }
  })
})

// — Multiple keys deferred via before() —————————————————————————————————————————

describe('multiple env keys deferred via before() all capture correctly (issue #390)', { timeout: 2000 }, () => {
  const KEY_X = '__DEFERRED_MULTI_X_390__'
  const KEY_Y = '__DEFERRED_MULTI_Y_390__'
  let savedX
  let savedY

  before(() => {
    process.env[KEY_X] = 'initial_x'
    process.env[KEY_Y] = 'initial_y'
    savedX = saveEnv(KEY_X)
    savedY = saveEnv(KEY_Y)
  })

  afterEach(() => {
    restoreEnv(KEY_X, savedX)
    restoreEnv(KEY_Y, savedY)
  })

  after(() => {
    delete process.env[KEY_X]
    delete process.env[KEY_Y]
  })

  it('both keys captured correctly in before() hook', () => {
    assert.equal(savedX, 'initial_x')
    assert.equal(savedY, 'initial_y')
  })

  it('mutating one key does not affect the other after afterEach', () => {
    process.env[KEY_X] = 'mutated_x'
    // KEY_Y untouched
    assert.equal(process.env[KEY_X], 'mutated_x')
    assert.equal(process.env[KEY_Y], 'initial_y')
  })

  it('both keys restored after previous mutation', () => {
    assert.equal(process.env[KEY_X], 'initial_x',
      'KEY_X should be restored by afterEach')
    assert.equal(process.env[KEY_Y], 'initial_y',
      'KEY_Y should be restored by afterEach')
  })

  it('mutating both keys is cleaned up', () => {
    process.env[KEY_X] = 'both_mutated_x'
    process.env[KEY_Y] = 'both_mutated_y'
    assert.equal(process.env[KEY_X], 'both_mutated_x')
    assert.equal(process.env[KEY_Y], 'both_mutated_y')
  })

  it('both restored after both were mutated', () => {
    assert.equal(process.env[KEY_X], 'initial_x')
    assert.equal(process.env[KEY_Y], 'initial_y')
  })
})

// — saveEnv at describe scope with undefined env ——————————————————————————————

describe('describe-scope saveEnv with unset key returns undefined consistently (issue #390)', { timeout: 2000 }, () => {
  const NEVER_SET_KEY = '__NEVER_SET_DESCRIBE_SCOPE_390__'
  const descScopeSaved = saveEnv(NEVER_SET_KEY)

  afterEach(() => {
    restoreEnv(NEVER_SET_KEY, descScopeSaved)
  })

  it('saved value is undefined for a key that was never set', () => {
    assert.equal(descScopeSaved, undefined)
  })

  it('setting and restoring an originally-unset key deletes it', () => {
    process.env[NEVER_SET_KEY] = 'temporarily_set'
    assert.equal(process.env[NEVER_SET_KEY], 'temporarily_set')
    // afterEach will delete it since descScopeSaved is undefined
  })

  it('key is deleted after afterEach restores undefined', () => {
    assert.equal(Object.hasOwn(process.env, NEVER_SET_KEY), false,
      'key should not exist after restoreEnv with undefined')
  })
})

// — Demonstrate the recommended fix pattern ———————————————————————————————————

describe('recommended pattern: let + before replaces const at describe scope (issue #390)', { timeout: 2000 }, () => {
  const FIX_KEY = '__RECOMMENDED_FIX_390__'
  let saved // declared at describe scope, assigned in before()

  before(() => {
    saved = saveEnv(FIX_KEY)
  })

  afterEach(() => {
    restoreEnv(FIX_KEY, saved)
  })

  it('saved is assigned by the time tests run', () => {
    // Even though `saved` is undefined at describe-registration time,
    // by the time this test runs, before() has executed.
    // For an unset key, saved is still undefined — but intentionally so,
    // because before() ran and saveEnv returned undefined.
    assert.equal(saved, saveEnv(FIX_KEY),
      'saved should match current env state since before() just captured it')
  })

  it('mutation followed by afterEach restore works with deferred save', () => {
    process.env[FIX_KEY] = 'fix_pattern_mutation'
    assert.equal(process.env[FIX_KEY], 'fix_pattern_mutation')
  })

  it('restored after mutation using deferred save', () => {
    if (saved !== undefined) {
      assert.equal(process.env[FIX_KEY], saved)
    } else {
      assert.equal(Object.hasOwn(process.env, FIX_KEY), false)
    }
  })
})
