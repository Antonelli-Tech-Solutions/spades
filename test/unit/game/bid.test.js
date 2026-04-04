import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getBiddingOrder,
  isEligibleForBlindNil,
  isSecondTeamBidder,
  teamHasBlindNil,
  isValidBidValue,
  getPartnerSeat,
  computeTeamBids,
  TEAM_FOR_SEAT,
} from '../../../server/game/bid.js'

describe('getBiddingOrder', { timeout: 2000 }, () => {
  it('starts with player left of dealer (clockwise)', { timeout: 2000 }, () => {
    // North deals → east goes first
    const order = getBiddingOrder('north')
    assert.deepEqual(order, ['east', 'south', 'west', 'north'])
  })

  it('rotates correctly for east dealer', { timeout: 2000 }, () => {
    const order = getBiddingOrder('east')
    assert.deepEqual(order, ['south', 'west', 'north', 'east'])
  })

  it('rotates correctly for south dealer', { timeout: 2000 }, () => {
    const order = getBiddingOrder('south')
    assert.deepEqual(order, ['west', 'north', 'east', 'south'])
  })

  it('rotates correctly for west dealer', { timeout: 2000 }, () => {
    const order = getBiddingOrder('west')
    assert.deepEqual(order, ['north', 'east', 'south', 'west'])
  })
})

describe('TEAM_FOR_SEAT', { timeout: 2000 }, () => {
  it('north and south are on ns team', { timeout: 2000 }, () => {
    assert.equal(TEAM_FOR_SEAT.north, 'ns')
    assert.equal(TEAM_FOR_SEAT.south, 'ns')
  })

  it('east and west are on ew team', { timeout: 2000 }, () => {
    assert.equal(TEAM_FOR_SEAT.east, 'ew')
    assert.equal(TEAM_FOR_SEAT.west, 'ew')
  })
})

describe('getPartnerSeat', { timeout: 2000 }, () => {
  it('north partner is south', { timeout: 2000 }, () => {
    assert.equal(getPartnerSeat('north'), 'south')
  })

  it('south partner is north', { timeout: 2000 }, () => {
    assert.equal(getPartnerSeat('south'), 'north')
  })

  it('east partner is west', { timeout: 2000 }, () => {
    assert.equal(getPartnerSeat('east'), 'west')
  })

  it('west partner is east', { timeout: 2000 }, () => {
    assert.equal(getPartnerSeat('west'), 'east')
  })
})

describe('isEligibleForBlindNil', { timeout: 2000 }, () => {
  it('eligible when team is 100+ points behind', { timeout: 2000 }, () => {
    assert.ok(isEligibleForBlindNil({ ns: 0, ew: 100 }, 'north'))
  })

  it('eligible when exactly 100 behind', { timeout: 2000 }, () => {
    assert.ok(isEligibleForBlindNil({ ns: 50, ew: 150 }, 'north'))
  })

  it('not eligible when less than 100 behind', { timeout: 2000 }, () => {
    assert.ok(!isEligibleForBlindNil({ ns: 50, ew: 149 }, 'north'))
  })

  it('not eligible when ahead', { timeout: 2000 }, () => {
    assert.ok(!isEligibleForBlindNil({ ns: 200, ew: 100 }, 'north'))
  })

  it('works for ew team players', { timeout: 2000 }, () => {
    assert.ok(isEligibleForBlindNil({ ns: 200, ew: 50 }, 'east'))
  })
})

describe('teamHasBlindNil', { timeout: 2000 }, () => {
  it('returns true if partner bid blind nil', { timeout: 2000 }, () => {
    const bids = { north: 'blind_nil', east: null, south: null, west: null }
    assert.ok(teamHasBlindNil(bids, 'south'))
  })

  it('returns false if no one on team bid blind nil', { timeout: 2000 }, () => {
    const bids = { north: 4, east: null, south: null, west: null }
    assert.ok(!teamHasBlindNil(bids, 'north'))
  })

  it('returns true for the blind nil bidder themselves', { timeout: 2000 }, () => {
    const bids = { north: 'blind_nil', east: null, south: null, west: null }
    assert.ok(teamHasBlindNil(bids, 'north'))
  })
})

describe('isValidBidValue', { timeout: 2000 }, () => {
  it('accepts integers 0–13', { timeout: 2000 }, () => {
    for (let i = 0; i <= 13; i++) {
      assert.ok(isValidBidValue(i), `${i} should be valid`)
    }
  })

  it('rejects negative numbers', { timeout: 2000 }, () => {
    assert.ok(!isValidBidValue(-1))
  })

  it('rejects 14 and above', { timeout: 2000 }, () => {
    assert.ok(!isValidBidValue(14))
  })

  it('accepts "nil"', { timeout: 2000 }, () => {
    assert.ok(isValidBidValue('nil'))
  })

  it('accepts "blind_nil"', { timeout: 2000 }, () => {
    assert.ok(isValidBidValue('blind_nil'))
  })

  it('rejects strings other than nil/blind_nil', { timeout: 2000 }, () => {
    assert.ok(!isValidBidValue('five'))
  })

  it('rejects non-integer numbers', { timeout: 2000 }, () => {
    assert.ok(!isValidBidValue(3.5))
  })
})

describe('isSecondTeamBidder', { timeout: 2000 }, () => {
  it('west is second EW bidder when north deals', { timeout: 2000 }, () => {
    // North deals → order: east, south, west, north
    // EW: east bids first, west bids second
    const order = getBiddingOrder('north')
    assert.ok(isSecondTeamBidder('west', order))
  })

  it('east is NOT second EW bidder when north deals', { timeout: 2000 }, () => {
    const order = getBiddingOrder('north')
    assert.ok(!isSecondTeamBidder('east', order))
  })

  it('north is second NS bidder when north deals', { timeout: 2000 }, () => {
    // North deals → order: east, south, west, north
    // NS: south bids first, north bids second
    const order = getBiddingOrder('north')
    assert.ok(isSecondTeamBidder('north', order))
  })

  it('south is NOT second NS bidder when north deals', { timeout: 2000 }, () => {
    const order = getBiddingOrder('north')
    assert.ok(!isSecondTeamBidder('south', order))
  })

  it('first and second bidder roles rotate with dealer', { timeout: 2000 }, () => {
    // East deals → order: south, west, north, east
    // NS: south bids first, north bids second
    // EW: west bids first, east bids second
    const order = getBiddingOrder('east')
    assert.ok(!isSecondTeamBidder('south', order))
    assert.ok(isSecondTeamBidder('north', order))
    assert.ok(!isSecondTeamBidder('west', order))
    assert.ok(isSecondTeamBidder('east', order))
  })
})

describe('computeTeamBids', { timeout: 2000 }, () => {
  it('second bidder number overrides first bidder number', { timeout: 2000 }, () => {
    // North deals → bidding: east, south, west, north
    // EW: east bids first (4), west bids second (7) → EW team bid = 7
    // NS: south bids first (3), north bids second (5) → NS team bid = 5
    const bids = { north: 5, east: 4, south: 3, west: 7 }
    const biddingOrder = getBiddingOrder('north')
    const teamBids = computeTeamBids(bids, biddingOrder)
    assert.equal(teamBids.ew, 7)
    assert.equal(teamBids.ns, 5)
  })

  it('first bidder number is kept when second bidder bids nil', { timeout: 2000 }, () => {
    // EW: east bids 4 first, west bids nil → EW team bid = 4 (east's individual number)
    const bids = { north: 5, east: 4, south: 3, west: 'nil' }
    const biddingOrder = getBiddingOrder('north')
    const teamBids = computeTeamBids(bids, biddingOrder)
    assert.equal(teamBids.ew, 4)
  })

  it('returns null team bid for double nil team', { timeout: 2000 }, () => {
    // NS: both bid nil
    const bids = { north: 'nil', east: 4, south: 'nil', west: 7 }
    const biddingOrder = getBiddingOrder('north')
    const teamBids = computeTeamBids(bids, biddingOrder)
    assert.equal(teamBids.ns, null)
    assert.equal(teamBids.ew, 7)
  })

  it('handles first bidder nil with second bidder number', { timeout: 2000 }, () => {
    // EW: east bids nil first, west bids 5 → EW team bid = 5 (west bids the team total, east's nil stands individually)
    const bids = { north: 5, east: 'nil', south: 3, west: 5 }
    const biddingOrder = getBiddingOrder('north')
    const teamBids = computeTeamBids(bids, biddingOrder)
    assert.equal(teamBids.ew, 5)
  })

  it('team bid of 0 is preserved', { timeout: 2000 }, () => {
    const bids = { north: 0, east: 4, south: 0, west: 7 }
    const biddingOrder = getBiddingOrder('north')
    const teamBids = computeTeamBids(bids, biddingOrder)
    assert.equal(teamBids.ns, 0)
  })
})
