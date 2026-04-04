import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createInputBlocker } from '../../../client/web/src/inputBlock.js'

describe('createInputBlocker', { timeout: 2000 }, () => {
  it('starts unblocked', { timeout: 2000 }, () => {
    const blocker = createInputBlocker()
    assert.equal(blocker.isBlocked(), false)
  })

  it('is blocked after block()', { timeout: 2000 }, () => {
    const blocker = createInputBlocker()
    blocker.block()
    assert.equal(blocker.isBlocked(), true)
  })

  it('is unblocked after unblock()', { timeout: 2000 }, () => {
    const blocker = createInputBlocker()
    blocker.block()
    blocker.unblock()
    assert.equal(blocker.isBlocked(), false)
  })

  it('unblock() is idempotent when already unblocked', { timeout: 2000 }, () => {
    const blocker = createInputBlocker()
    blocker.unblock()
    blocker.unblock()
    assert.equal(blocker.isBlocked(), false)
  })

  it('block() does not stack — a single unblock() clears it', { timeout: 2000 }, () => {
    const blocker = createInputBlocker()
    blocker.block()
    blocker.block()
    blocker.unblock()
    assert.equal(blocker.isBlocked(), false)
  })

  it('can be re-blocked after unblocking', { timeout: 2000 }, () => {
    const blocker = createInputBlocker()
    blocker.block()
    blocker.unblock()
    blocker.block()
    assert.equal(blocker.isBlocked(), true)
  })

  it('two instances are independent', { timeout: 2000 }, () => {
    const a = createInputBlocker()
    const b = createInputBlocker()
    a.block()
    assert.equal(a.isBlocked(), true)
    assert.equal(b.isBlocked(), false)
  })
})
