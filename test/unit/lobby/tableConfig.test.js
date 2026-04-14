import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveJoinPolicy } from '../../../server/lobby/table.js'

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
