import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getDisplayBid } from '../../../client/web/src/screens/game.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(bids, { biddingOrder = ['north', 'east', 'south', 'west'], teamBids = {} } = {}) {
  return {
    bids,
    biddingOrder,
    teamBids: { ns: null, ew: null, ...teamBids },
  }
}

// ---------------------------------------------------------------------------
// getDisplayBid
// ---------------------------------------------------------------------------

describe('getDisplayBid', { timeout: 2000 }, () => {
  it('returns raw bid for first bidder in a numeric partnership', { timeout: 2000 }, () => {
    // North bids 4 first. South enters 7 as team total.
    // North is the first bidder — should show 4 (their advisory individual bid).
    const state = makeState(
      { north: 4, south: 7, east: null, west: null },
      { biddingOrder: ['north', 'east', 'south', 'west'] },
    )
    assert.equal(getDisplayBid(state, 'north'), 4)
  })

  it('returns individual contribution for second bidder in a numeric partnership', { timeout: 2000 }, () => {
    // South is the second NS bidder, stored bid is team total 7, partner bid 4.
    // Individual contribution = 7 - 4 = 3.
    const state = makeState(
      { north: 4, south: 7, east: null, west: null },
      { biddingOrder: ['north', 'east', 'south', 'west'] },
    )
    assert.equal(getDisplayBid(state, 'south'), 3)
  })

  it('handles zero first bid (second bidder contribution equals team total)', { timeout: 2000 }, () => {
    // North bids 0. South enters 4 as team total. South individual = 4 - 0 = 4.
    const state = makeState(
      { north: 0, south: 4, east: null, west: null },
    )
    assert.equal(getDisplayBid(state, 'south'), 4)
    assert.equal(getDisplayBid(state, 'north'), 0)
  })

  it('returns null for un-bid seat', { timeout: 2000 }, () => {
    const state = makeState({ north: 4, south: null, east: null, west: null })
    assert.equal(getDisplayBid(state, 'south'), null)
  })

  it('returns nil string unchanged', { timeout: 2000 }, () => {
    const state = makeState({ north: 'nil', south: 4, east: null, west: null })
    assert.equal(getDisplayBid(state, 'north'), 'nil')
  })

  it('returns blind_nil string unchanged', { timeout: 2000 }, () => {
    const state = makeState({ north: 'blind_nil', south: 4, east: null, west: null })
    assert.equal(getDisplayBid(state, 'north'), 'blind_nil')
  })

  it('second bidder with nil partner bid returns raw bid (not subtracted)', { timeout: 2000 }, () => {
    // Partner bid is Nil (not numeric) — no contribution math applies.
    const state = makeState(
      { north: 'nil', south: 4, east: null, west: null },
      { biddingOrder: ['north', 'east', 'south', 'west'] },
    )
    assert.equal(getDisplayBid(state, 'south'), 4)
  })

  it('works for E/W team — East is first bidder', { timeout: 2000 }, () => {
    const state = makeState(
      { north: null, south: null, east: 5, west: 8 },
      { biddingOrder: ['north', 'east', 'south', 'west'] },
    )
    assert.equal(getDisplayBid(state, 'east'), 5)
    assert.equal(getDisplayBid(state, 'west'), 3) // 8 - 5
  })

  it('handles biddingOrder where South bids before North', { timeout: 2000 }, () => {
    // Dealer = East, so order is south, west, north, east.
    // South bids first for NS (advisory 3). North enters 7 as team total. North individual = 4.
    const state = makeState(
      { north: 7, south: 3, east: null, west: null },
      { biddingOrder: ['south', 'west', 'north', 'east'] },
    )
    assert.equal(getDisplayBid(state, 'south'), 3)  // first bidder — unchanged
    assert.equal(getDisplayBid(state, 'north'), 4)  // second bidder: 7 - 3 = 4
  })

  it('returns raw bid when partner has not yet bid (no biddingOrder context)', { timeout: 2000 }, () => {
    // Only one player on team has bid — no individual calculation possible.
    const state = makeState(
      { north: 4, south: null, east: null, west: null },
    )
    assert.equal(getDisplayBid(state, 'north'), 4)
  })

  it('maximum total (13): second bidder shows correct individual', { timeout: 2000 }, () => {
    // North bids 7, South enters 13 as team total. South individual = 6.
    const state = makeState(
      { north: 7, south: 13, east: null, west: null },
    )
    assert.equal(getDisplayBid(state, 'south'), 6)
    assert.equal(getDisplayBid(state, 'north'), 7)
  })
})
