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

  it('is unblocked after block() then unblock()', () => {
    const blocker = createInputBlocker()
    blocker.block()
    blocker.unblock()
    assert.equal(blocker.isBlocked(), false)
  })

  it('calling unblock() when already unblocked is a no-op', () => {
    const blocker = createInputBlocker()
    blocker.unblock()
    assert.equal(blocker.isBlocked(), false)
  })

  it('multiple block() calls do not stack — one unblock() clears the block', () => {
    const blocker = createInputBlocker()
    blocker.block()
    blocker.block()
    blocker.unblock()
    assert.equal(blocker.isBlocked(), false)
  })

  it('can be blocked again after being unblocked', () => {
    const blocker = createInputBlocker()
    blocker.block()
    blocker.unblock()
    blocker.block()
    assert.equal(blocker.isBlocked(), true)
  })

  it('each createInputBlocker() call returns an independent instance', () => {
    const a = createInputBlocker()
    const b = createInputBlocker()
    a.block()
    assert.equal(a.isBlocked(), true)
    assert.equal(b.isBlocked(), false)
  })
})
