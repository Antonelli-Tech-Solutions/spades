/**
 * Tests for GitHub issue #390 — consolidated per issue #436.
 *
 * Four focused tests:
 *   1. describe-scope saveEnv captures load-time value (the problem)
 *   2. before()-scope saveEnv captures run-time value (the fix)
 *   3. cross-describe pollution demo
 *   4. multi-key deferred capture via before()
 */
import { describe, it, before, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

// — 1. Describe-scope captures load-time value ————————————————————————————————

describe('describe-scope saveEnv captures load-time value (issue #390)', { timeout: 2000 }, () => {
  const ENV_KEY = 'GIT_COMMIT_SHA'
  const descScopeSaved = saveEnv(ENV_KEY)
  const loadTimeValue = Object.hasOwn(process.env, ENV_KEY)
    ? process.env[ENV_KEY]
    : undefined

  afterEach(() => {
    restoreEnv(ENV_KEY, descScopeSaved)
  })

  it('captures the env value at file-load time and freezes it', () => {
    assert.equal(descScopeSaved, loadTimeValue,
      'saveEnv at describe scope should capture the value present at load time')

    process.env[ENV_KEY] = 'post_load_mutation_436'
    assert.equal(descScopeSaved, loadTimeValue,
      'describe-scope saved value must not change when env is mutated later')
  })
})

// — 2. before()-scope captures run-time value ——————————————————————————————————

describe('before()-scope saveEnv captures run-time value (issue #390)', { timeout: 2000 }, () => {
  const DEFERRED_KEY = '__BEFORE_HOOK_DEFERRED_436__'
  let savedInBefore

  before(() => {
    process.env[DEFERRED_KEY] = 'known_runtime_value'
    savedInBefore = saveEnv(DEFERRED_KEY)
  })

  afterEach(() => {
    restoreEnv(DEFERRED_KEY, savedInBefore)
  })

  after(() => {
    delete process.env[DEFERRED_KEY]
  })

  it('captures the value set during hook execution and restores after mutation', () => {
    assert.equal(savedInBefore, 'known_runtime_value',
      'saveEnv in before() should capture the value at hook-run time')

    process.env[DEFERRED_KEY] = 'mutated_in_test_436'
    assert.equal(process.env[DEFERRED_KEY], 'mutated_in_test_436')
  })

  it('afterEach restores to the before-hook captured value', () => {
    assert.equal(process.env[DEFERRED_KEY], 'known_runtime_value',
      'afterEach should restore to the value captured in before()')
  })
})

// — 3. Cross-describe pollution demo —————————————————————————————————————————
//
// ⚠️  SELF-POLLUTION WARNING (issue #435)
// This describe block intentionally sets process.env at describe scope to
// demonstrate the anti-pattern. The key name is intentionally long and unique
// to avoid collisions with any real env var or other test key.

describe('cross-describe pollution via describe-scope saveEnv (issue #390)', { timeout: 2000 }, () => {
  const POLLUTE_KEY = '__CROSS_FILE_POLLUTION_436_DEMO_ANTIPATTERN_DO_NOT_REUSE__'

  process.env[POLLUTE_KEY] = 'pollution_from_prior_file'
  const descScopeSaved = saveEnv(POLLUTE_KEY)

  afterEach(() => {
    restoreEnv(POLLUTE_KEY, descScopeSaved)
  })

  after(() => {
    delete process.env[POLLUTE_KEY]
  })

  it('describe-scope saveEnv captures pollution and restores to it', () => {
    assert.equal(descScopeSaved, 'pollution_from_prior_file',
      'describe-scope saveEnv captured pollution — it cannot distinguish original from leaked')

    process.env[POLLUTE_KEY] = 'test_mutation'
  })

  it('afterEach restores to the polluted value, not the true original', () => {
    assert.equal(process.env[POLLUTE_KEY], 'pollution_from_prior_file',
      'afterEach restored to the pollution, not the true original (undefined)')
  })
})

// — 4. Multiple keys deferred via before() ———————————————————————————————————

describe('multiple env keys deferred via before() all capture correctly (issue #390)', { timeout: 2000 }, () => {
  const KEY_X = '__DEFERRED_MULTI_X_436__'
  const KEY_Y = '__DEFERRED_MULTI_Y_436__'
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

  it('both keys captured correctly and restored independently after mutation', () => {
    assert.equal(savedX, 'initial_x')
    assert.equal(savedY, 'initial_y')

    process.env[KEY_X] = 'mutated_x'
    assert.equal(process.env[KEY_X], 'mutated_x')
    assert.equal(process.env[KEY_Y], 'initial_y')
  })

  it('both keys restored after mutation', () => {
    assert.equal(process.env[KEY_X], 'initial_x',
      'KEY_X should be restored by afterEach')
    assert.equal(process.env[KEY_Y], 'initial_y',
      'KEY_Y should be restored by afterEach')
  })
})
