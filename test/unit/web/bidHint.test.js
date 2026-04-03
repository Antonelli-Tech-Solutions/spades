import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bidContributionHint } from '../../../client/web/src/screens/game.js'

describe('bidContributionHint', () => {
  it('computes yourBid as teamTotal minus partnerBid', () => {
    const result = bidContributionHint(7, 4)
    assert.equal(result.yourBid, 3)
  })

  it('isWarning is false when teamTotal equals partnerBid (zero contribution)', () => {
    const result = bidContributionHint(4, 4)
    assert.equal(result.yourBid, 0)
    assert.equal(result.isWarning, false)
  })

  it('isWarning is false when teamTotal is above partnerBid', () => {
    const result = bidContributionHint(7, 4)
    assert.equal(result.isWarning, false)
  })

  it('isWarning is true when teamTotal is below partnerBid', () => {
    const result = bidContributionHint(2, 4)
    assert.equal(result.isWarning, true)
  })

  it('yourBid is negative when teamTotal is below partnerBid (warns, does not clamp)', () => {
    const result = bidContributionHint(2, 4)
    assert.equal(result.yourBid, -2)
  })

  it('works when partnerBid is 0', () => {
    const result = bidContributionHint(5, 0)
    assert.equal(result.yourBid, 5)
    assert.equal(result.isWarning, false)
  })

  it('works when teamTotal is 0 and partnerBid is 0', () => {
    const result = bidContributionHint(0, 0)
    assert.equal(result.yourBid, 0)
    assert.equal(result.isWarning, false)
  })

  it('returns both fields as an object', () => {
    const result = bidContributionHint(6, 3)
    assert.ok(Object.hasOwn(result, 'yourBid'), 'result must have yourBid')
    assert.ok(Object.hasOwn(result, 'isWarning'), 'result must have isWarning')
  })

  it('handles large team total', () => {
    const result = bidContributionHint(13, 6)
    assert.equal(result.yourBid, 7)
    assert.equal(result.isWarning, false)
  })
})
