import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { leaveGameButtonHtml } from '../../../client/web/src/screens/game.js'

describe('leaveGameButtonHtml', { timeout: 2000 }, () => {
  it('returns a string', { timeout: 2000 }, () => {
    assert.equal(typeof leaveGameButtonHtml(), 'string')
  })

  it('contains a button with id leave-game-btn', { timeout: 2000 }, () => {
    const html = leaveGameButtonHtml()
    assert.ok(html.includes('id="leave-game-btn"'), 'should include leave-game-btn id')
  })

  it('contains "Leave Game" text', { timeout: 2000 }, () => {
    const html = leaveGameButtonHtml()
    assert.ok(html.includes('Leave Game'), 'should include "Leave Game" text')
  })
})
