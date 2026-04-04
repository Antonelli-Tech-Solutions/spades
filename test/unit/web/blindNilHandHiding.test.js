import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { blindNilHandHtml, blindNilChoicePanelHtml } from '../../../client/web/src/screens/game.js'

// ---------------------------------------------------------------------------
// blindNilHandHtml
// ---------------------------------------------------------------------------

describe('blindNilHandHtml', { timeout: 2000 }, () => {
  it('renders exactly 13 face-down card backs', { timeout: 2000 }, () => {
    const html = blindNilHandHtml()
    const matches = html.match(/card-back/g) || []
    assert.equal(matches.length, 13)
  })

  it('each card element has both card and card-back classes', { timeout: 2000 }, () => {
    const html = blindNilHandHtml()
    const cardBacks = html.match(/class="card card-back"/g) || []
    assert.equal(cardBacks.length, 13)
  })

  it('does not include data-suit attribute (no card info leaked)', { timeout: 2000 }, () => {
    const html = blindNilHandHtml()
    assert.ok(!html.includes('data-suit'), 'must not expose card suit')
  })

  it('does not include data-rank attribute (no card info leaked)', { timeout: 2000 }, () => {
    const html = blindNilHandHtml()
    assert.ok(!html.includes('data-rank'), 'must not expose card rank')
  })

  it('returns a non-empty string', { timeout: 2000 }, () => {
    const html = blindNilHandHtml()
    assert.ok(typeof html === 'string' && html.length > 0)
  })
})

// ---------------------------------------------------------------------------
// blindNilChoicePanelHtml
// ---------------------------------------------------------------------------

describe('blindNilChoicePanelHtml', { timeout: 2000 }, () => {
  it('wraps output in a blind-nil-choice-panel container', { timeout: 2000 }, () => {
    const html = blindNilChoicePanelHtml()
    assert.ok(html.includes('blind-nil-choice-panel'), 'should have choice panel container class')
  })

  it('contains a Reveal Hand button with id blind-nil-reveal-btn', { timeout: 2000 }, () => {
    const html = blindNilChoicePanelHtml()
    assert.ok(html.includes('id="blind-nil-reveal-btn"'), 'should have reveal hand button id')
    assert.ok(html.includes('Reveal Hand'), 'should have Reveal Hand label')
  })

  it('contains a Bid Blind Nil button with id blind-nil-bid-btn', { timeout: 2000 }, () => {
    const html = blindNilChoicePanelHtml()
    assert.ok(html.includes('id="blind-nil-bid-btn"'), 'should have bid blind nil button id')
    assert.ok(html.includes('Bid Blind Nil'), 'should have Bid Blind Nil label')
  })

  it('contains an error container with role alert for action failures', { timeout: 2000 }, () => {
    const html = blindNilChoicePanelHtml()
    assert.ok(html.includes('blind-nil-err'), 'should have error container class')
    assert.ok(html.includes('role="alert"'), 'error container should have alert role')
  })

  it('error container has aria-live polite for screen reader announcements', { timeout: 2000 }, () => {
    const html = blindNilChoicePanelHtml()
    assert.ok(html.includes('aria-live="polite"'), 'error container should announce politely')
  })

  it('Reveal Hand button comes before Bid Blind Nil button in markup', { timeout: 2000 }, () => {
    const html = blindNilChoicePanelHtml()
    const revealIdx = html.indexOf('blind-nil-reveal-btn')
    const bidIdx = html.indexOf('blind-nil-bid-btn')
    assert.ok(revealIdx < bidIdx, 'Reveal Hand should appear before Bid Blind Nil')
  })
})
