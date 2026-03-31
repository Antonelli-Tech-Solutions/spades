import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scoreHand, checkWinLoss, applyBagPenalties } from '../../../server/game/score.js'

describe('scoreHand — basic team bid', () => {
  it('awards bid × 10 when team makes their bid exactly', () => {
    const { scoreDelta, newBags } = scoreHand({
      bids: { north: 3, east: 4, south: 4, west: 3 },
      teamBids: { ns: 7, ew: 7 },
      tricksWon: { north: 3, east: 4, south: 4, west: 3 },
    })
    assert.equal(scoreDelta.ns, 70)
    assert.equal(scoreDelta.ew, 70)
    assert.equal(newBags.ns, 0)
    assert.equal(newBags.ew, 0)
  })

  it('awards overtricks as bags (+1 per overtrick, not +10)', () => {
    const { scoreDelta, newBags } = scoreHand({
      bids: { north: 3, east: 4, south: 4, west: 3 },
      teamBids: { ns: 7, ew: 7 },
      tricksWon: { north: 4, east: 5, south: 4, west: 3 },
    })
    // NS: 8 tricks vs bid 7 → +70 + 1 bag
    assert.equal(scoreDelta.ns, 70)
    assert.equal(newBags.ns, 1)
    // EW: 8 tricks vs bid 7 → +70 + 1 bag
    assert.equal(scoreDelta.ew, 70)
    assert.equal(newBags.ew, 1)
  })

  it('deducts bid × 10 when team misses their bid', () => {
    const { scoreDelta, newBags } = scoreHand({
      bids: { north: 4, east: 4, south: 4, west: 3 },
      teamBids: { ns: 8, ew: 7 },
      tricksWon: { north: 3, east: 3, south: 3, west: 4 },
    })
    // NS: 6 tricks vs bid 8 → -80
    assert.equal(scoreDelta.ns, -80)
    assert.equal(newBags.ns, 0)
    // EW: 7 tricks vs bid 7 → +70
    assert.equal(scoreDelta.ew, 70)
    assert.equal(newBags.ew, 0)
  })
})

describe('scoreHand — nil bid', () => {
  it('awards +50 for a successful nil', () => {
    const { scoreDelta } = scoreHand({
      bids: { north: 'nil', east: 4, south: 5, west: 3 },
      teamBids: { ns: 5, ew: 7 },
      tricksWon: { north: 0, east: 4, south: 5, west: 3 },
    })
    // North made nil: +50. NS also made team bid of 5: +50
    assert.equal(scoreDelta.ns, 50 + 50)
  })

  it('deducts -50 for a failed nil', () => {
    const { scoreDelta, newBags } = scoreHand({
      bids: { north: 'nil', east: 4, south: 5, west: 3 },
      teamBids: { ns: 5, ew: 7 },
      tricksWon: { north: 2, east: 4, south: 3, west: 3 },
    })
    // North failed nil: -50
    // NS team: north(2) + south(3) = 5 tricks vs bid 5 → +50, 0 bags
    assert.equal(scoreDelta.ns, -50 + 50)
    assert.equal(newBags.ns, 0)
  })

  it('nil bidder tricks that push team over bid create bags', () => {
    const { scoreDelta, newBags } = scoreHand({
      bids: { north: 'nil', east: 4, south: 5, west: 3 },
      teamBids: { ns: 5, ew: 7 },
      // North fails nil with 3 tricks; south has 5; team total = 8, bid = 5 → 3 bags
      tricksWon: { north: 3, east: 4, south: 5, west: 3 },
    })
    // North failed nil: -50
    // NS: 8 tricks vs bid 5 → +50 + 3 bags
    assert.equal(scoreDelta.ns, -50 + 50)
    assert.equal(newBags.ns, 3)
  })
})

describe('scoreHand — blind nil bid', () => {
  it('awards +100 for a successful blind nil', () => {
    const { scoreDelta } = scoreHand({
      bids: { north: 'blind_nil', east: 4, south: 5, west: 3 },
      teamBids: { ns: 5, ew: 7 },
      tricksWon: { north: 0, east: 4, south: 5, west: 3 },
    })
    assert.ok(scoreDelta.ns >= 100 + 50) // +100 blind nil + +50 team
  })

  it('deducts -100 for a failed blind nil', () => {
    const { scoreDelta } = scoreHand({
      bids: { north: 'blind_nil', east: 4, south: 5, west: 3 },
      teamBids: { ns: 5, ew: 7 },
      tricksWon: { north: 1, east: 4, south: 4, west: 3 },
    })
    // North failed blind nil: -100
    // NS: 5 tricks vs bid 5 → +50
    assert.equal(scoreDelta.ns, -100 + 50)
  })
})

describe('scoreHand — double nil', () => {
  it('awards +50 to each successful individual nil in a double nil', () => {
    const { scoreDelta, newBags } = scoreHand({
      bids: { north: 'nil', east: 4, south: 'nil', west: 3 },
      teamBids: { ns: null, ew: 7 },
      tricksWon: { north: 0, east: 4, south: 0, west: 3 },
    })
    // Both made nil: +50 + +50 = +100 for NS
    assert.equal(scoreDelta.ns, 100)
    assert.equal(newBags.ns, 0)
  })

  it('every trick in double nil is a bag and breaks individual nil', () => {
    const { scoreDelta, newBags } = scoreHand({
      bids: { north: 'nil', east: 4, south: 'nil', west: 3 },
      teamBids: { ns: null, ew: 7 },
      tricksWon: { north: 2, east: 4, south: 0, west: 3 },
    })
    // North failed nil (-50); south made nil (+50); north's 2 tricks = 2 bags
    assert.equal(scoreDelta.ns, -50 + 50)
    assert.equal(newBags.ns, 2)
  })
})

describe('scoreHand — team bid of 0', () => {
  it('every trick is a bag when team bids 0', () => {
    const { scoreDelta, newBags } = scoreHand({
      bids: { north: 0, east: 4, south: 0, west: 3 },
      teamBids: { ns: 0, ew: 7 },
      tricksWon: { north: 2, east: 4, south: 1, west: 3 },
    })
    // NS team bid 0: every trick is a bag, no positive/negative score
    assert.equal(scoreDelta.ns, 0)
    assert.equal(newBags.ns, 3) // 2 + 1
  })
})

describe('applyBagPenalties', () => {
  it('deducts 100 points per 10 bags accumulated', () => {
    const { scores, bags } = applyBagPenalties(
      { ns: 150, ew: 100 },
      { ns: 9, ew: 5 },
      { ns: 3, ew: 2 },
    )
    // NS: 9 + 3 = 12 bags → 1 penalty (−100), 2 bags remaining
    assert.equal(scores.ns, 50) // 150 - 100
    assert.equal(bags.ns, 2)
    // EW: 5 + 2 = 7 bags → no penalty
    assert.equal(scores.ew, 100)
    assert.equal(bags.ew, 7)
  })

  it('deducts 200 when accumulating 20+ bags', () => {
    const { scores, bags } = applyBagPenalties(
      { ns: 300, ew: 100 },
      { ns: 15, ew: 0 },
      { ns: 8, ew: 0 },
    )
    // NS: 15 + 8 = 23 bags → 2 penalties (−200), 3 bags remaining
    assert.equal(scores.ns, 100) // 300 - 200
    assert.equal(bags.ns, 3)
  })

  it('does not deduct when fewer than 10 bags total', () => {
    const { scores, bags } = applyBagPenalties(
      { ns: 100, ew: 100 },
      { ns: 4, ew: 4 },
      { ns: 3, ew: 3 },
    )
    assert.equal(scores.ns, 100)
    assert.equal(bags.ns, 7)
    assert.equal(scores.ew, 100)
    assert.equal(bags.ew, 7)
  })
})

describe('checkWinLoss', () => {
  it('returns win for team that reaches 250', () => {
    const result = checkWinLoss({ ns: 250, ew: 100 })
    assert.equal(result.winner, 'ns')
    assert.equal(result.loser, 'ew')
  })

  it('returns win for higher-scoring team when both reach 250', () => {
    const result = checkWinLoss({ ns: 260, ew: 255 })
    assert.equal(result.winner, 'ns')
  })

  it('returns null when tied at exactly 250 (play another hand)', () => {
    const result = checkWinLoss({ ns: 250, ew: 250 })
    assert.equal(result, null)
  })

  it('returns loss for team that reaches -250', () => {
    const result = checkWinLoss({ ns: -250, ew: 100 })
    assert.equal(result.loser, 'ns')
    assert.equal(result.winner, 'ew')
  })

  it('higher score wins when both reach -250', () => {
    const result = checkWinLoss({ ns: -260, ew: -255 })
    assert.equal(result.winner, 'ew') // ew has higher score
  })

  it('returns null when tied at exactly -250 (play another hand)', () => {
    const result = checkWinLoss({ ns: -250, ew: -250 })
    assert.equal(result, null)
  })

  it('returns null when neither threshold is reached', () => {
    const result = checkWinLoss({ ns: 100, ew: 150 })
    assert.equal(result, null)
  })

  it('win condition takes priority over loss when one team hits 250 and other hits -250', () => {
    // Both conditions — winner is the team above 250
    const result = checkWinLoss({ ns: 250, ew: -250 })
    assert.equal(result.winner, 'ns')
  })
})
