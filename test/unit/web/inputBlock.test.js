import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createInputBlocker } from '../../../client/web/src/inputBlock.js'

describe('createInputBlocker', () => {
  it('starts unblocked', () => {
    const blocker = createInputBlocker()
    assert.equal(blocker.isBlocked(), false)
  })

  it('is blocked after block()', () => {
    const blocker = createInputBlocker()
    blocker.block()
    assert.equal(blocker.isBlocked(), true)
  })

  it('is unblocked after unblock()', () => {
    const blocker = createInputBlocker()
    blocker.block()
    blocker.unblock()
    assert.equal(blocker.isBlocked(), false)
  })

  it('unblock() is idempotent when already unblocked', () => {
    const blocker = createInputBlocker()
    blocker.unblock()
    blocker.unblock()
    assert.equal(blocker.isBlocked(), false)
  })

  it('block() does not stack — a single unblock() clears it', () => {
    const blocker = createInputBlocker()
    blocker.block()
    blocker.block()
    blocker.unblock()
    assert.equal(blocker.isBlocked(), false)
  })

  it('can be re-blocked after unblocking', () => {
    const blocker = createInputBlocker()
    blocker.block()
    blocker.unblock()
    blocker.block()
    assert.equal(blocker.isBlocked(), true)
  })

  it('two instances are independent', () => {
    const a = createInputBlocker()
    const b = createInputBlocker()
    a.block()
    assert.equal(a.isBlocked(), true)
    assert.equal(b.isBlocked(), false)
  })
})
