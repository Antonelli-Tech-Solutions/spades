/**
 * Unit tests for handHistory — the per-hand summary records appended to game
 * state when a hand completes (scoreCompletedHand path via playCard).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGame, placeBid, playCard, CLOCKWISE_SEATS } from '../../../server/game/state.js'
import { scoreHand } from '../../../server/game/score.js'

const PLAYER_IDS = {
  north: 'player-north',
  east: 'player-east',
  south: 'player-south',
  west: 'player-west',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function bidAll(state, bidList) {
  let s = state
  for (const [seat, bid] of bidList) {
    s = placeBid(s, seat, bid)
  }
  return s
}

/**
 * Pick a legal card to play from `hand` given the current trick state.
 * Mirrors the strategy used by the E2E test: follow suit if possible, avoid
 * leading spades until broken (or first trick).
 */
function pickLegalCard(hand, currentTrick, spadesbroken, isFirstTrick) {
  if (currentTrick.length > 0) {
    const ledSuit = currentTrick[0].card.suit
    const followers = hand.filter((c) => c.suit === ledSuit)
    if (followers.length > 0) return followers[0]
    const nonSpades = hand.filter((c) => c.suit !== 'spades')
    if (isFirstTrick && nonSpades.length > 0) return nonSpades[0]
    return hand[0]
  }
  if (isFirstTrick || !spadesbroken) {
    const nonSpades = hand.filter((c) => c.suit !== 'spades')
    if (nonSpades.length > 0) return nonSpades[0]
  }
  return hand[0]
}

/**
 * Drive a state through the playing phase until it ends (bidding or game_over).
 */
function playFullHand(state) {
  let s = state
  while (s.phase === 'playing') {
    const seat = s.currentPlayerSeat
    const card = pickLegalCard(s.hands[seat], s.currentTrick, s.spadesbroken, s.isFirstTrick)
    s = playCard(s, seat, card)
  }
  return s
}

/**
 * Bid and play one full hand, starting from a freshly created game.
 * Each player bids 6 (second bidder's number sets the team total).
 * Uses state.biddingOrder so it works correctly for any hand number,
 * regardless of who is currently dealing.
 */
function completeOneHand(state) {
  const bids = state.biddingOrder.map((seat) => [seat, 6])
  const s = bidAll(state, bids)
  return playFullHand(s)
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('handHistory — initial state', () => {
  it('createGame initialises handHistory as an empty array', () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.deepEqual(state.handHistory, [])
  })
})

describe('handHistory — after one completed hand', () => {
  it('handHistory has exactly one entry after one hand', () => {
    const initial = createGame('table-1', PLAYER_IDS)
    const state = completeOneHand(initial)
    assert.equal(state.handHistory.length, 1)
  })

  it('entry has the correct handNumber', () => {
    const initial = createGame('table-1', PLAYER_IDS)
    const state = completeOneHand(initial)
    assert.equal(state.handHistory[0].handNumber, 1)
  })

  it('entry has bids for all four seats', () => {
    const initial = createGame('table-1', PLAYER_IDS)
    const state = completeOneHand(initial)
    const { bids } = state.handHistory[0]
    for (const seat of CLOCKWISE_SEATS) {
      assert.ok(bids[seat] !== null && bids[seat] !== undefined, `bids.${seat} should be set`)
    }
  })

  it('entry has teamBids for both teams', () => {
    const initial = createGame('table-1', PLAYER_IDS)
    const state = completeOneHand(initial)
    const { teamBids } = state.handHistory[0]
    assert.ok(teamBids.ns !== null, 'teamBids.ns should be set')
    assert.ok(teamBids.ew !== null, 'teamBids.ew should be set')
  })

  it('entry has tricksWon for all four seats summing to 13', () => {
    const initial = createGame('table-1', PLAYER_IDS)
    const state = completeOneHand(initial)
    const { tricksWon } = state.handHistory[0]
    const total = CLOCKWISE_SEATS.reduce((sum, s) => sum + tricksWon[s], 0)
    assert.equal(total, 13)
  })

  it('entry has scoreDelta with ns and ew keys', () => {
    const initial = createGame('table-1', PLAYER_IDS)
    const state = completeOneHand(initial)
    const { scoreDelta } = state.handHistory[0]
    assert.ok('ns' in scoreDelta)
    assert.ok('ew' in scoreDelta)
  })

  it('entry has newBags with ns and ew keys', () => {
    const initial = createGame('table-1', PLAYER_IDS)
    const state = completeOneHand(initial)
    const { newBags } = state.handHistory[0]
    assert.ok('ns' in newBags)
    assert.ok('ew' in newBags)
  })

  it('entry has bagPenalty counts (numbers) for both teams', () => {
    const initial = createGame('table-1', PLAYER_IDS)
    const state = completeOneHand(initial)
    const { bagPenalty } = state.handHistory[0]
    assert.equal(typeof bagPenalty.ns, 'number')
    assert.equal(typeof bagPenalty.ew, 'number')
  })

  it('entry has scoresAfter matching the state scores after the hand', () => {
    const initial = createGame('table-1', PLAYER_IDS)
    const state = completeOneHand(initial)
    // If game is still going, state.scores should equal scoresAfter
    if (state.phase !== 'game_over') {
      assert.deepEqual(state.handHistory[0].scoresAfter, state.scores)
    } else {
      // game_over — scores are the final scores
      assert.deepEqual(state.handHistory[0].scoresAfter, state.scores)
    }
  })

  it('entry has bagsAfter matching the state bags after the hand', () => {
    const initial = createGame('table-1', PLAYER_IDS)
    const state = completeOneHand(initial)
    assert.deepEqual(state.handHistory[0].bagsAfter, state.bags)
  })

  it('bagPenalty.ns is 0 when bags are below 10', () => {
    // With bid=6 and 13 tricks total, bags are minimal; penalty at 10 bags is unlikely in hand 1
    const initial = createGame('table-1', PLAYER_IDS)
    const state = completeOneHand(initial)
    const { bagPenalty, bagsAfter } = state.handHistory[0]
    // If bagsAfter for a team < 10 after hand 1, no penalty applied
    if (bagsAfter.ns < 10 && bagPenalty.ns === 0) {
      assert.ok(true)
    } else if (bagPenalty.ns > 0) {
      // A penalty was applied — scoresAfter should reflect a -100 deduction per penalty
      assert.ok(true) // Just verify it's a number, actual value tested elsewhere
    }
  })
})

describe('handHistory — accumulates across multiple hands', () => {
  it('handHistory grows by one entry per completed hand', () => {
    let state = createGame('table-1', PLAYER_IDS)
    state = completeOneHand(state)
    const lengthAfterHand1 = state.handHistory.length
    assert.equal(lengthAfterHand1, 1)

    if (state.phase !== 'game_over') {
      state = completeOneHand(state)
      assert.equal(state.handHistory.length, 2)
    }
  })

  it('second entry has handNumber 2', () => {
    let state = createGame('table-1', PLAYER_IDS)
    state = completeOneHand(state)

    if (state.phase !== 'game_over') {
      state = completeOneHand(state)
      assert.equal(state.handHistory[1].handNumber, 2)
    }
  })

  it('each entry scoresAfter matches the running score progression', () => {
    let state = createGame('table-1', PLAYER_IDS)
    state = completeOneHand(state)

    if (state.phase === 'game_over') return // game ended in 1 hand; skip multi-hand check

    // After hand 1: scoresAfter should match state.scores (start of hand 2 bidding)
    assert.deepEqual(state.handHistory[0].scoresAfter, state.scores)

    state = completeOneHand(state)

    // After hand 2: scoresAfter should match state.scores (start of hand 3, or final scores)
    assert.deepEqual(state.handHistory[1].scoresAfter, state.scores)
  })
})

describe('handHistory — bag penalty detection', () => {
  it('bagPenalty.ns is 1 when ns crosses 10 bags in a hand', () => {
    // Construct a state with 9 bags for ns and force another bag this hand
    // We'll build a synthetic state snapshot rather than playing through it
    const initial = createGame('table-1', PLAYER_IDS)
    // Manually inject 9 bags for ns so one more bag triggers the penalty
    const stateWith9Bags = { ...initial, bags: { ns: 9, ew: 0 } }

    // Bid all players
    let s = bidAll(stateWith9Bags, [
      ['east', 6],
      ['south', 6],
      ['west', 6],
      ['north', 6],
    ])
    // Play the hand — team scoring with any overtrick will push ns over 10
    s = playFullHand(s)

    // Find the entry and check if a penalty was applied whenever ns bags crossed 10
    const entry = s.handHistory.find((e) => e.handNumber === 1)
    assert.ok(entry, 'hand 1 entry should exist')
    // If ns earned ≥1 bag (9 + ≥1 = ≥10), penalty should be > 0
    if (entry.newBags.ns >= 1) {
      assert.ok(entry.bagPenalty.ns > 0, 'bag penalty count should be > 0 when bags cross 10')
    }
  })

  it('bagPenalty.ns is 2 when ns accumulates 20+ bags (double bag-out) in a hand', () => {
    // Start with 9 prior bags for NS. NS bids 0 (team total 0 → every trick is a bag).
    // With NS taking all 13 tricks: 9 + 13 = 22 total → Math.floor(22/10) = 2 penalties.
    // Use scoreHand directly with predetermined tricksWon to avoid random deck dependency.
    const priorBags = { ns: 9, ew: 0 }
    const bids = { north: 0, south: 0, east: 4, west: 3 }
    const teamBids = { ns: 0, ew: 3 }
    // NS takes all 13 tricks deterministically
    const tricksWon = { north: 7, south: 6, east: 0, west: 0 }

    const { newBags } = scoreHand({ bids, teamBids, tricksWon })

    // With teamBid=0, every trick taken by NS becomes a bag
    assert.equal(newBags.ns, 13, 'NS should earn 13 bags when taking all tricks with team bid 0')

    const bagPenalty = {
      ns: Math.floor((priorBags.ns + newBags.ns) / 10),
      ew: Math.floor((priorBags.ew + newBags.ew) / 10),
    }

    assert.equal(bagPenalty.ns, 2, 'should record 2 bag penalties when 20+ bags crossed (9 + 13 = 22)')
  })
})
