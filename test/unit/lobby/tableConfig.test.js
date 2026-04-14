import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveJoinPolicy, validateJoinPolicy } from '../../../server/lobby/table.js'

describe('resolveJoinPolicy', { timeout: 2000 }, () => {
  it('defaults to "open" for public visibility', () => {
    assert.equal(resolveJoinPolicy('public', undefined), 'open')
  })

  it('allows "friends-only" join policy for public visibility', () => {
    assert.equal(resolveJoinPolicy('public', 'friends-only'), 'friends-only')
  })

  it('allows "invite-only" join policy for public visibility', () => {
    assert.equal(resolveJoinPolicy('public', 'invite-only'), 'invite-only')
  })

  it('defaults to "friends-only" for friends-only visibility', () => {
    assert.equal(resolveJoinPolicy('friends-only', undefined), 'friends-only')
  })

  it('allows "invite-only" join policy for friends-only visibility', () => {
    assert.equal(resolveJoinPolicy('friends-only', 'invite-only'), 'invite-only')
  })

  it('rejects "open" join policy for friends-only visibility and falls back to default', () => {
    assert.equal(resolveJoinPolicy('friends-only', 'open'), 'friends-only')
  })

  it('always returns "invite-only" for private visibility', () => {
    assert.equal(resolveJoinPolicy('private', undefined), 'invite-only')
  })

  it('ignores "open" join policy for private visibility', () => {
    assert.equal(resolveJoinPolicy('private', 'open'), 'invite-only')
  })

  it('ignores "friends-only" join policy for private visibility', () => {
    assert.equal(resolveJoinPolicy('private', 'friends-only'), 'invite-only')
  })

  it('handles null joinPolicy as undefined', () => {
    assert.equal(resolveJoinPolicy('public', null), 'open')
    assert.equal(resolveJoinPolicy('friends-only', null), 'friends-only')
    assert.equal(resolveJoinPolicy('private', null), 'invite-only')
  })
})

describe('validateJoinPolicy', { timeout: 2000 }, () => {
  it('returns null for all valid public combinations', () => {
    assert.equal(validateJoinPolicy('public', 'open'), null)
    assert.equal(validateJoinPolicy('public', 'friends-only'), null)
    assert.equal(validateJoinPolicy('public', 'invite-only'), null)
  })

  it('returns null for valid friends-only combinations', () => {
    assert.equal(validateJoinPolicy('friends-only', 'friends-only'), null)
    assert.equal(validateJoinPolicy('friends-only', 'invite-only'), null)
  })

  it('returns error for open join policy with friends-only visibility', () => {
    const err = validateJoinPolicy('friends-only', 'open')
    assert.ok(err)
    assert.ok(err.includes('not allowed'))
  })

  it('returns null for invite-only with private visibility', () => {
    assert.equal(validateJoinPolicy('private', 'invite-only'), null)
  })

  it('returns error for open join policy with private visibility', () => {
    const err = validateJoinPolicy('private', 'open')
    assert.ok(err)
    assert.ok(err.includes('not allowed'))
  })

  it('returns error for friends-only join policy with private visibility', () => {
    const err = validateJoinPolicy('private', 'friends-only')
    assert.ok(err)
    assert.ok(err.includes('not allowed'))
  })

  it('returns null when joinPolicy is null or undefined', () => {
    assert.equal(validateJoinPolicy('public', null), null)
    assert.equal(validateJoinPolicy('private', undefined), null)
  })
})
