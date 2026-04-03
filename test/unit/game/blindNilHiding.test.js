import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGame, getPlayerView, revealHand, placeBid } from '../../../server/game/state.js'

const PLAYER_IDS = {
  north: 'player-north',
  east: 'player-east',
  south: 'player-south',
  west: 'player-west',
}

/**
 * Build a game state where NS team is eligible for Blind Nil (100+ behind).
 * NS has 0, EW has 100 → NS is exactly 100 behind.
 */
function makeNsEligibleState() {
  const state = createGame('table-bnh-test', PLAYER_IDS)
  return { ...state, scores: { ns: 0, ew: 100 } }
}

/**
 * Build a game state where neither team is eligible (scores even).
 */
function makeNoEligibleState() {
  return createGame('table-bnh-test', PLAYER_IDS)
  // scores start at {ns: 0, ew: 0} — neither team is 100+ behind
}

// ── getPlayerView: hand hiding ──────────────────────────────────────────────

describe('getPlayerView — Blind Nil hand hiding', () => {
  it('eligible player does not receive myHand before revealing', () => {
    const state = makeNsEligibleState()
    const view = getPlayerView(state, 'north')
    assert.equal(view.myHand, undefined, 'myHand should be omitted for eligible player')
  })

  it('eligible player has blindNilEligible: true before revealing', () => {
    const state = makeNsEligibleState()
    const view = getPlayerView(state, 'north')
    assert.equal(view.blindNilEligible, true)
  })

  it('both NS players are eligible when NS is 100+ behind', () => {
    const state = makeNsEligibleState()
    const northView = getPlayerView(state, 'north')
    const southView = getPlayerView(state, 'south')
    assert.equal(northView.myHand, undefined, 'north hand should be hidden')
    assert.equal(northView.blindNilEligible, true)
    assert.equal(southView.myHand, undefined, 'south hand should be hidden')
    assert.equal(southView.blindNilEligible, true)
  })

  it('ineligible team (EW) receives full hand immediately', () => {
    const state = makeNsEligibleState()
    const eastView = getPlayerView(state, 'east')
    const westView = getPlayerView(state, 'west')
    assert.ok(Array.isArray(eastView.myHand), 'east should receive myHand')
    assert.equal(eastView.myHand.length, 13)
    assert.ok(Array.isArray(westView.myHand), 'west should receive myHand')
    assert.equal(westView.myHand.length, 13)
  })

  it('ineligible player has blindNilEligible: false', () => {
    const state = makeNsEligibleState()
    const eastView = getPlayerView(state, 'east')
    assert.equal(eastView.blindNilEligible, false, 'blindNilEligible must be false for ineligible player')
  })

  it('eligible player receives myHand after reveal-hand', () => {
    const state = makeNsEligibleState()
    const revealed = revealHand(state, 'north')
    const view = getPlayerView(revealed, 'north')
    assert.ok(Array.isArray(view.myHand), 'myHand should be present after reveal')
    assert.equal(view.myHand.length, 13)
  })

  it('HAND_REVEALED is not sent before reveal-hand — south still hidden after north reveals', () => {
    const state = makeNsEligibleState()
    const revealedNorth = revealHand(state, 'north')
    const southView = getPlayerView(revealedNorth, 'south')
    assert.equal(southView.myHand, undefined, 'south hand should still be hidden')
  })

  it('when no team is eligible all players receive their hand immediately', () => {
    const state = makeNoEligibleState()
    for (const seat of ['north', 'east', 'south', 'west']) {
      const view = getPlayerView(state, seat)
      assert.ok(Array.isArray(view.myHand), `${seat} should receive myHand`)
      assert.equal(view.myHand.length, 13)
    }
  })
})

// ── revealHand: validation ──────────────────────────────────────────────────

describe('revealHand — validation', () => {
  it('rejects if player is not eligible for Blind Nil', () => {
    const state = makeNsEligibleState() // EW is not eligible
    assert.throws(
      () => revealHand(state, 'east'),
      (err) => {
        assert.equal(err.code, 'NOT_ELIGIBLE')
        return true
      },
    )
  })

  it('rejects if player has already placed a bid', () => {
    const state = makeNsEligibleState()
    // Directly set a bid for north (last in bidding order for north dealer)
    const stateWithBid = { ...state, bids: { ...state.bids, north: 4 } }
    assert.throws(
      () => revealHand(stateWithBid, 'north'),
      (err) => {
        assert.equal(err.code, 'BID_ALREADY_PLACED')
        return true
      },
    )
  })

  it('rejects if game is not in bidding phase', () => {
    const state = makeNsEligibleState()
    const playingState = { ...state, phase: 'playing' }
    assert.throws(
      () => revealHand(playingState, 'north'),
      (err) => {
        assert.equal(err.code, 'INVALID_ACTION')
        return true
      },
    )
  })

  it('succeeds and returns state with seat in handRevealedSeats', () => {
    const state = makeNsEligibleState()
    const newState = revealHand(state, 'north')
    assert.ok(newState.handRevealedSeats.includes('north'))
  })

  it('does not mutate original state', () => {
    const state = makeNsEligibleState()
    revealHand(state, 'north')
    assert.deepEqual(state.handRevealedSeats, [])
  })
})

// ── Bid Blind Nil directly — hand never revealed ────────────────────────────

describe('Blind Nil bid without reveal — hand remains hidden during bidding', () => {
  it('eligible player who bids Blind Nil directly never reveals their hand during bidding', () => {
    // North dealer → bidding order: east, south, west, north
    // NS is eligible; east bids first (EW), south bids second (NS)
    // Have east bid, then south bid blind_nil directly (without calling reveal-hand)
    const state = makeNsEligibleState()

    // east bids first
    const afterEast = placeBid(state, 'east', 4)
    // south bids blind_nil directly (NS is eligible)
    const afterSouth = placeBid(afterEast, 'south', 'blind_nil')

    // south's view should still not include myHand during bidding phase
    // (they chose not to reveal; their hand is withheld)
    const southView = getPlayerView(afterSouth, 'south')
    assert.equal(southView.myHand, undefined, 'south chose blind nil — hand must not be sent during bidding')
  })
})
