/**
 * Unit tests for test/helpers/envHelper.js (saveEnv / restoreEnv).
 *
 * Extracted from buildInfoIdempotencyServerCouplingRefactor.test.js (issue #377).
 * The Part 2 integration tests in that file were redundant with the already-
 * refactored buildInfoIdempotencyServerCoupling.test.js and should be deleted.
 * These unit tests are the valuable, non-redundant portion and belong here.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

// Use a unique key that won't collide with real env vars
const TEST_KEY = '__ENVHELPER_UNIT_TEST_KEY__'

describe('saveEnv/restoreEnv helpers (issue #377)', { timeout: 2000 }, () => {
  afterEach(() => {
    // Always clean up regardless of test outcome
    delete process.env[TEST_KEY]
  })

  // ── saveEnv ───────────────────────────────────────────────────────────

  it('saveEnv returns undefined when env var is not set', () => {
    delete process.env[TEST_KEY]
    const saved = saveEnv(TEST_KEY)
    assert.equal(saved, undefined)
  })

  it('saveEnv returns the current value when env var is set', () => {
    process.env[TEST_KEY] = 'hello'
    const saved = saveEnv(TEST_KEY)
    assert.equal(saved, 'hello')
  })

  it('saveEnv returns empty string for empty env var (not undefined)', () => {
    process.env[TEST_KEY] = ''
    const saved = saveEnv(TEST_KEY)
    assert.equal(saved, '')
  })

  it('saveEnv distinguishes between unset and empty string', () => {
    delete process.env[TEST_KEY]
    const unsetResult = saveEnv(TEST_KEY)

    process.env[TEST_KEY] = ''
    const emptyResult = saveEnv(TEST_KEY)

    assert.equal(unsetResult, undefined, 'unset var should return undefined')
    assert.equal(emptyResult, '', 'empty var should return empty string')
    assert.notEqual(unsetResult, emptyResult, 'undefined !== empty string')
  })

  // ── restoreEnv ────────────────────────────────────────────────────────

  it('restoreEnv sets the var when savedValue is a string', () => {
    delete process.env[TEST_KEY]
    restoreEnv(TEST_KEY, 'restored_value')
    assert.equal(process.env[TEST_KEY], 'restored_value')
  })

  it('restoreEnv deletes the var when savedValue is undefined', () => {
    process.env[TEST_KEY] = 'should_be_removed'
    restoreEnv(TEST_KEY, undefined)
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false)
  })

  it('restoreEnv sets empty string correctly (does not delete)', () => {
    delete process.env[TEST_KEY]
    restoreEnv(TEST_KEY, '')
    assert.equal(process.env[TEST_KEY], '')
    assert.equal(Object.hasOwn(process.env, TEST_KEY), true)
  })

  it('restoreEnv overwrites existing value', () => {
    process.env[TEST_KEY] = 'old_value'
    restoreEnv(TEST_KEY, 'new_value')
    assert.equal(process.env[TEST_KEY], 'new_value')
  })

  // ── Round-trip: save → mutate → restore ───────────────────────────────

  it('round-trip preserves original set value', () => {
    process.env[TEST_KEY] = 'original'
    const saved = saveEnv(TEST_KEY)
    process.env[TEST_KEY] = 'modified'
    restoreEnv(TEST_KEY, saved)
    assert.equal(process.env[TEST_KEY], 'original')
  })

  it('round-trip preserves original unset state', () => {
    delete process.env[TEST_KEY]
    const saved = saveEnv(TEST_KEY)
    process.env[TEST_KEY] = 'temporary'
    restoreEnv(TEST_KEY, saved)
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false)
  })

  it('round-trip preserves empty string value', () => {
    process.env[TEST_KEY] = ''
    const saved = saveEnv(TEST_KEY)
    process.env[TEST_KEY] = 'not_empty'
    restoreEnv(TEST_KEY, saved)
    assert.equal(process.env[TEST_KEY], '')
  })

  // ── Idempotency ───────────────────────────────────────────────────────

  it('restoreEnv is idempotent — calling twice with same string is safe', () => {
    process.env[TEST_KEY] = 'value'
    restoreEnv(TEST_KEY, 'restored')
    restoreEnv(TEST_KEY, 'restored')
    assert.equal(process.env[TEST_KEY], 'restored')
  })

  it('restoreEnv is idempotent — calling twice with undefined is safe', () => {
    process.env[TEST_KEY] = 'value'
    restoreEnv(TEST_KEY, undefined)
    restoreEnv(TEST_KEY, undefined)
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false)
  })

  // ── Edge cases ────────────────────────────────────────────────────────

  it('saveEnv handles values with special characters', () => {
    const special = 'path=/usr/bin:val=a&b=c "quoted" \'single\''
    process.env[TEST_KEY] = special
    const saved = saveEnv(TEST_KEY)
    assert.equal(saved, special)
  })

  it('round-trip handles values with newlines', () => {
    const multiline = 'line1\nline2\nline3'
    process.env[TEST_KEY] = multiline
    const saved = saveEnv(TEST_KEY)
    process.env[TEST_KEY] = 'overwritten'
    restoreEnv(TEST_KEY, saved)
    assert.equal(process.env[TEST_KEY], multiline)
  })

  it('restoreEnv with undefined on already-unset key is a no-op', () => {
    delete process.env[TEST_KEY]
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false)
    restoreEnv(TEST_KEY, undefined)
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false)
  })

  // ── Multiple independent keys ─────────────────────────────────────────

  it('saveEnv/restoreEnv on one key does not affect another key', () => {
    const KEY_A = '__ENVHELPER_UNIT_A__'
    const KEY_B = '__ENVHELPER_UNIT_B__'
    try {
      process.env[KEY_A] = 'alpha'
      process.env[KEY_B] = 'beta'
      const savedA = saveEnv(KEY_A)
      process.env[KEY_A] = 'changed'
      restoreEnv(KEY_A, savedA)
      assert.equal(process.env[KEY_A], 'alpha')
      assert.equal(process.env[KEY_B], 'beta', 'KEY_B must be untouched')
    } finally {
      delete process.env[KEY_A]
      delete process.env[KEY_B]
    }
  })

  // ── process.env string coercion ───────────────────────────────────────

  it('saveEnv returns string even when value was set as a number', () => {
    process.env[TEST_KEY] = 42
    const saved = saveEnv(TEST_KEY)
    assert.equal(typeof saved, 'string')
    assert.equal(saved, '42')
  })

  it('round-trip preserves numeric-looking string value', () => {
    process.env[TEST_KEY] = '3000'
    const saved = saveEnv(TEST_KEY)
    process.env[TEST_KEY] = '9999'
    restoreEnv(TEST_KEY, saved)
    assert.equal(process.env[TEST_KEY], '3000')
  })

  // ── Very long value ───────────────────────────────────────────────────

  it('round-trip handles very long values', () => {
    const longVal = 'x'.repeat(10_000)
    process.env[TEST_KEY] = longVal
    const saved = saveEnv(TEST_KEY)
    process.env[TEST_KEY] = 'short'
    restoreEnv(TEST_KEY, saved)
    assert.equal(process.env[TEST_KEY], longVal)
  })
})
