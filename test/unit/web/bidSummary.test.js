import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { teamBidSummaryHtml } from '../../../client/web/src/screens/game.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal game state for teamBidSummaryHtml.
 *
 * bids: raw stored bid per seat (second bidder's numeric value = team total).
 * teamBids: authoritative team totals (computed server-side by computeTeamBids).
 * biddingOrder: seat order clockwise from left of dealer.
 */
function makeState(bids, { teamBids = {}, biddingOrder = ['north', 'east', 'south', 'west'] } = {}) {
  return { bids, teamBids: { ns: null, ew: null, ...teamBids }, biddingOrder }
}

// ---------------------------------------------------------------------------
// teamBidSummaryHtml
// ---------------------------------------------------------------------------

describe('teamBidSummaryHtml', { timeout: 2000 }, () => {
  it('returns empty string when no team has finished bidding', { timeout: 2000 }, () => {
    const state = makeState({ north: null, south: null, east: null, west: null })
    assert.equal(teamBidSummaryHtml(state), '')
  })

  it('returns empty string when only one player on a team has bid', { timeout: 2000 }, () => {
    const state = makeState({ north: 4, south: null, east: null, west: null })
    assert.equal(teamBidSummaryHtml(state), '')
  })

  it('renders N/S summary with correct team total and individual contributions', { timeout: 2000 }, () => {
    // North bids 4 (first, advisory). South enters 7 as team total (second bidder).
    // state.bids.south = 7 (team total), teamBids.ns = 7, South individual = 7 - 4 = 3.
    const state = makeState(
      { north: 4, south: 7, east: null, west: null },
      { teamBids: { ns: 7 } },
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('N/S'), 'should include team label N/S')
    assert.ok(html.includes('7'), 'should show team total 7')
    assert.ok(html.includes('North 4'), 'should show North individual bid 4')
    assert.ok(html.includes('South 3'), 'should show South individual contribution 3')
    assert.ok(!html.match(/N\/S: 11/), 'should not show wrong total 11 (4+7)')
  })

  it('renders N/S summary when South is the first bidder', { timeout: 2000 }, () => {
    // With dealer = west, biddingOrder = ['north', 'east', 'south', 'west'].
    // Use a dealer = south so biddingOrder = ['west', 'north', 'east', 'south'].
    // Here South bids last for NS — North bids first: North 5, South enters 8 as team total.
    // South individual = 8 - 5 = 3.
    const state = makeState(
      { north: 5, south: 8, east: null, west: null },
      { teamBids: { ns: 8 } },
      // default biddingOrder: north first, south second for NS
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('N/S: 8'), 'should show team total 8')
    assert.ok(html.includes('North 5'), 'should show first bidder North 5')
    assert.ok(html.includes('South 3'), 'should show second bidder South individual 3')
  })

  it('renders E/W summary once both E/W players have bid', { timeout: 2000 }, () => {
    // East bids 5 (first for EW). West enters 8 as team total (second for EW).
    // West individual = 8 - 5 = 3.
    const state = makeState(
      { north: null, south: null, east: 5, west: 8 },
      { teamBids: { ew: 8 } },
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('E/W'), 'should include team label E/W')
    assert.ok(html.includes('8'), 'should show team total 8')
    assert.ok(html.includes('East 5'), 'should show East individual bid 5')
    assert.ok(html.includes('West 3'), 'should show West individual contribution 3')
  })

  it('renders both team summaries when all four players have bid', { timeout: 2000 }, () => {
    // NS: North 4, South enters 7 (team total). EW: East 5, West enters 7 (team total).
    const state = makeState(
      { north: 4, south: 7, east: 5, west: 7 },
      { teamBids: { ns: 7, ew: 7 } },
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('N/S'), 'should include N/S')
    assert.ok(html.includes('E/W'), 'should include E/W')
    assert.ok(html.includes('bid-summary-team'), 'should use bid-summary-team class')
  })

  it('wraps output in a bid-summary container', { timeout: 2000 }, () => {
    const state = makeState(
      { north: 4, south: 7, east: null, west: null },
      { teamBids: { ns: 7 } },
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('bid-summary'), 'should include bid-summary class')
  })

  it('shows Nil bid individually and excludes it from team total', { timeout: 2000 }, () => {
    // North bids nil (first). South bids 4 (second, team total = 4).
    const state = makeState(
      { north: 'nil', south: 4, east: null, west: null },
      { teamBids: { ns: 4 } },
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('N/S'), 'should include team label')
    assert.ok(html.includes('Nil'), 'should show Nil label')
    assert.ok(!html.match(/N\/S: \d+ —/), 'should not show a combined numeric total when one bid is Nil')
  })

  it('shows Blind Nil bid individually and excludes it from team total', { timeout: 2000 }, () => {
    const state = makeState(
      { north: 'blind_nil', south: 4, east: null, west: null },
      { teamBids: { ns: 4 } },
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('Blind Nil'), 'should show Blind Nil label')
    assert.ok(!html.match(/N\/S: \d+ —/), 'should not show a combined numeric total when one bid is Blind Nil')
  })

  it('shows both Nil bids individually with no combined total', { timeout: 2000 }, () => {
    const state = makeState(
      { north: 'nil', south: 'nil', east: null, west: null },
      { teamBids: { ns: null } },
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('N/S'), 'should include team label')
    assert.ok(!html.match(/N\/S: \d+ —/), 'should not show a combined total for two Nil bids')
  })

  it('handles a zero first bid in the team total', { timeout: 2000 }, () => {
    // North bids 0 (first). South enters 4 as team total. South individual = 4.
    const state = makeState(
      { north: 0, south: 4, east: null, west: null },
      { teamBids: { ns: 4 } },
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('4'), 'should show team total of 4')
    assert.ok(html.includes('North 0'), 'should show North 0')
    assert.ok(html.includes('South 4'), 'should show South individual of 4')
  })

  it('handles maximum possible team total (13 tricks)', { timeout: 2000 }, () => {
    // North bids 7 (first). South enters 13 as team total. South individual = 6.
    const state = makeState(
      { north: 7, south: 13, east: null, west: null },
      { teamBids: { ns: 13 } },
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('13'), 'should show team total 13')
    assert.ok(html.includes('North 7'), 'should show North 7')
    assert.ok(html.includes('South 6'), 'should show South individual 6')
  })

  it('E/W summary with one Nil bid excludes Nil from team total', { timeout: 2000 }, () => {
    const state = makeState(
      { north: null, south: null, east: 'nil', west: 5 },
      { teamBids: { ew: 5 } },
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('E/W'), 'should include E/W label')
    assert.ok(html.includes('Nil'), 'should show Nil')
    assert.ok(!html.match(/E\/W: \d+ —/), 'should not show a combined numeric total')
  })

  it('renders correctly when teamBids is null but both players on a team have bid (mid-bidding)', { timeout: 2000 }, () => {
    // E/W finished bidding but N/S has not, so state.teamBids.ew is still null.
    // East bids 2 (first for EW), West enters 3 as team total (second for EW).
    // state.bids.west = 3 (team total stored as second bidder's value).
    // teamBids.ew is null because the server only populates it after all 4 players bid.
    const state = makeState(
      { north: null, south: null, east: 2, west: 3 },
      // teamBids.ew stays null (default from makeState)
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('E/W'), 'should include E/W label')
    assert.ok(html.includes('E/W: 3'), 'should show team total 3 from fallback bids[resolvedSecond]')
    assert.ok(html.includes('East 2'), 'should show first bidder East 2')
    assert.ok(html.includes('West 1'), 'should show second bidder West individual (3 − 2 = 1)')
    assert.ok(!html.includes('null'), 'must not render the word null')
  })

  it('true partnership case: second bidder value is team total, not individual', { timeout: 2000 }, () => {
    // This is the core partnership bug scenario.
    // North bids 4. South enters 7 meaning "our team bids 7 total".
    // state.bids.south = 7, but South's individual contribution is only 3.
    // The summary must show "N/S: 7 — North 4, South 3", NOT "N/S: 11 — North 4, South 7".
    const state = makeState(
      { north: 4, south: 7, east: null, west: null },
      { teamBids: { ns: 7 } },
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('N/S: 7'), 'team total must be 7 (the authoritative teamBids value)')
    assert.ok(html.includes('North 4'), 'first bidder shows their advisory number')
    assert.ok(html.includes('South 3'), 'second bidder shows individual contribution (7 − 4 = 3)')
    assert.ok(!html.includes('11'), 'must not incorrectly add raw bids (4 + 7 = 11)')
    assert.ok(!html.includes('South 7'), 'must not show second bidder raw team total as their individual bid')
  })

  it('shows correct E/W summary mid-hand when teamBids not yet computed (only E/W have bid)', { timeout: 2000 }, () => {
    // Regression test for issue #166: "E/W: null — East 2, West -2"
    // state.teamBids is only populated after ALL 4 players bid. If only E/W have
    // finished bidding, teamBids.ew is still null. The summary must fall back to
    // the second bidder's stored bid (which equals the team total per partnership rules).
    // East bids 2 (first for EW), West enters 3 as team total (second for EW).
    // state.bids.west = 3 (team total), state.teamBids.ew = null (not yet computed).
    const state = makeState(
      { north: null, south: null, east: 2, west: 3 },
      { teamBids: { ew: null } }, // teamBids not yet computed — only EW have bid
    )
    const html = teamBidSummaryHtml(state)
    assert.ok(html.includes('E/W: 3'), 'team total must be 3 (derived from second bidder\'s stored bid)')
    assert.ok(html.includes('East 2'), 'first bidder East shows advisory bid 2')
    assert.ok(html.includes('West 1'), 'second bidder West shows individual contribution (3 − 2 = 1)')
    assert.ok(!html.includes('null'), 'must not render "null" in the summary')
    assert.ok(!html.includes('West -'), 'must not show a negative individual bid for West')
  })
})
