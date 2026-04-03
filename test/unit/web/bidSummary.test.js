import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { teamBidSummaryHtml } from '../../../client/web/src/screens/game.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(bids) {
  return { bids }
}

// ---------------------------------------------------------------------------
// teamBidSummaryHtml
// ---------------------------------------------------------------------------

describe('teamBidSummaryHtml', () => {
  it('returns empty string when no team has finished bidding', () => {
    const state = makeState({ north: null, south: null, east: null, west: null })
    assert.equal(teamBidSummaryHtml(state), '')
  })

  it('returns empty string when only one player on a team has bid', () => {
    const state = makeState({ north: 4, south: null, east: null, west: null })
    assert.equal(teamBidSummaryHtml(state), '')
  })

  it('renders N/S summary once both N/S players have bid', () => {
    const state = makeState({ north: 4, south: 3, east: null, west: null })
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('N/S'), 'should include team label N/S')
    assert.ok(html.includes('7'), 'should show combined total 7')
    assert.ok(html.includes('North'), 'should show North seat name')
    assert.ok(html.includes('South'), 'should show South seat name')
  })

  it('renders E/W summary once both E/W players have bid', () => {
    const state = makeState({ north: null, south: null, east: 5, west: 3 })
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('E/W'), 'should include team label E/W')
    assert.ok(html.includes('8'), 'should show combined total 8')
    assert.ok(html.includes('East'), 'should show East seat name')
    assert.ok(html.includes('West'), 'should show West seat name')
  })

  it('renders both team summaries when all four players have bid', () => {
    const state = makeState({ north: 4, south: 3, east: 5, west: 2 })
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('N/S'), 'should include N/S')
    assert.ok(html.includes('E/W'), 'should include E/W')
    assert.ok(html.includes('7'), 'N/S total should be 7')
    assert.ok(html.includes('bid-summary-team'), 'should use bid-summary-team class')
  })

  it('wraps output in a bid-summary container', () => {
    const state = makeState({ north: 4, south: 3, east: null, west: null })
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('bid-summary'), 'should include bid-summary class')
  })

  it('shows Nil bid individually and excludes it from team total', () => {
    const state = makeState({ north: 'nil', south: 4, east: null, west: null })
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('N/S'), 'should include team label')
    assert.ok(html.includes('Nil'), 'should show Nil label')
    // Should not show a combined numeric total like "4" as a standalone total
    // The summary should just show individual bids
    assert.ok(!html.match(/N\/S: \d+ —/), 'should not show a combined numeric total when one bid is Nil')
  })

  it('shows Blind Nil bid individually and excludes it from team total', () => {
    const state = makeState({ north: 'blind_nil', south: 4, east: null, west: null })
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('Blind Nil'), 'should show Blind Nil label')
    assert.ok(!html.match(/N\/S: \d+ —/), 'should not show a combined numeric total when one bid is Blind Nil')
  })

  it('shows both Nil bids individually with no combined total', () => {
    const state = makeState({ north: 'nil', south: 'nil', east: null, west: null })
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('N/S'), 'should include team label')
    assert.ok(!html.match(/N\/S: \d+ —/), 'should not show a combined total for two Nil bids')
  })

  it('handles a zero bid in the team total', () => {
    const state = makeState({ north: 0, south: 4, east: null, west: null })
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('4'), 'should show combined total of 4')
    assert.ok(html.includes('North 0'), 'should show North 0')
  })

  it('handles maximum possible team total (13 tricks split across two players)', () => {
    const state = makeState({ north: 7, south: 6, east: null, west: null })
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('13'), 'should show combined total 13')
  })

  it('E/W summary with one Nil bid excludes Nil from team total', () => {
    const state = makeState({ north: null, south: null, east: 'nil', west: 5 })
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('E/W'), 'should include E/W label')
    assert.ok(html.includes('Nil'), 'should show Nil')
    assert.ok(!html.match(/E\/W: \d+ —/), 'should not show a combined numeric total')
  })
})
