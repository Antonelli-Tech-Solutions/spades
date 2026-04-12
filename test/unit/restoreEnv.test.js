import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { restoreEnv, saveEnv } from '../helpers/envHelper.js'

const TEST_KEY = '__RESTORE_ENV_TEST_KEY__'

describe('restoreEnv helper (issue #333)', { timeout: 2000 }, () => {
  afterEach(() => {
    delete process.env[TEST_KEY]
  })

  it('restores env var to a saved string value', () => {
    process.env[TEST_KEY] = 'modified'
    restoreEnv(TEST_KEY, 'original')
    assert.equal(process.env[TEST_KEY], 'original')
  })

  it('deletes env var when savedValue is undefined', () => {
    process.env[TEST_KEY] = 'should-be-deleted'
    restoreEnv(TEST_KEY, undefined)
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false)
  })

  it('restores env var to empty string (not delete)', () => {
    process.env[TEST_KEY] = 'non-empty'
    restoreEnv(TEST_KEY, '')
    assert.equal(process.env[TEST_KEY], '')
    assert.equal(Object.hasOwn(process.env, TEST_KEY), true)
  })

  describe('saveEnv helper', () => {
    it('returns the current value when env var is set', () => {
      process.env[TEST_KEY] = 'current-value'
      assert.equal(saveEnv(TEST_KEY), 'current-value')
    })

    it('returns undefined when env var is not set', () => {
      delete process.env[TEST_KEY]
      assert.equal(saveEnv(TEST_KEY), undefined)
    })
  })

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

      assert.equal(Object.hasOwn(process.env, TEST_KEY), false)
    })
  })
})
