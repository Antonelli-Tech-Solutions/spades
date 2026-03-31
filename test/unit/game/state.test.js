import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGame,
  placeBid,
  playCard,
  submitBlindNilExchange,
  getPlayerView,
  CLOCKWISE_SEATS,
} from '../../../server/game/state.js'

// Helper: play through all bids to get to 'playing' phase
function bidAll(state, bids) {
  for (const [seat, bid] of bids) {
    state = placeBid(state, seat, bid)
  }
  return state
}

// Helper: play out an entire hand using provided play sequences
// plays: [[seat, card], ...] for all 52 plays
function playTricks(state, plays) {
  for (const [seat, card] of plays) {
    state = playCard(state, seat, card)
  }
  return state
}

const PLAYER_IDS = {
  north: 'player-north',
  east: 'player-east',
  south: 'player-south',
  west: 'player-west',
}

describe('createGame', () => {
  it('creates a game in bidding phase', () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.equal(state.phase, 'bidding')
  })

  it('deals 13 cards to each player', () => {
    const state = createGame('table-1', PLAYER_IDS)
    for (const seat of CLOCKWISE_SEATS) {
      assert.equal(state.hands[seat].length, 13)
    }
  })

  it('hands are sorted by suit then rank', () => {
    const state = createGame('table-1', PLAYER_IDS)
    for (const seat of CLOCKWISE_SEATS) {
      const hand = state.hands[seat]
      for (let i = 1; i < hand.length; i++) {
        const prev = hand[i - 1]
        const curr = hand[i]
        const suitOrder = ['clubs', 'diamonds', 'hearts', 'spades']
        const rankOrder = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
        if (prev.suit === curr.suit) {
          assert.ok(
            rankOrder.indexOf(prev.rank) <= rankOrder.indexOf(curr.rank),
            `hand not sorted by rank for ${seat}`,
          )
        } else {
          assert.ok(
            suitOrder.indexOf(prev.suit) <= suitOrder.indexOf(curr.suit),
            `hand not sorted by suit for ${seat}`,
          )
        }
      }
    }
  })

  it('north is the dealer on the first hand', () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.equal(state.dealerSeat, 'north')
  })

  it('first bidder is east (left of north dealer)', () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.equal(state.currentBidderSeat, 'east')
  })

  it('initialises scores and bags to zero', () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.deepEqual(state.scores, { ns: 0, ew: 0 })
    assert.deepEqual(state.bags, { ns: 0, ew: 0 })
  })
})

describe('placeBid', () => {
  it('throws if not in bidding phase', () => {
    const state = createGame('table-1', PLAYER_IDS)
    // Manually set phase
    const badState = { ...state, phase: 'playing' }
    assert.throws(() => placeBid(badState, 'east', 3), /not in bidding phase/i)
  })

  it('throws if wrong player bids', () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.throws(() => placeBid(state, 'north', 3), /not your turn/i)
  })

  it('records the bid and advances to next bidder', () => {
    let state = createGame('table-1', PLAYER_IDS)
    state = placeBid(state, 'east', 3)
    assert.equal(state.bids.east, 3)
    assert.equal(state.currentBidderSeat, 'south')
  })

  it('transitions to playing phase after all 4 bids', () => {
    let state = createGame('table-1', PLAYER_IDS)
    state = bidAll(state, [
      ['east', 3],
      ['south', 4],
      ['west', 3],
      ['north', 7],
    ])
    assert.equal(state.phase, 'playing')
  })

  it('transitions to blind_nil_exchange when a player bids blind nil', () => {
    // Make NS far behind so blind nil is eligible
    let state = createGame('table-1', PLAYER_IDS)
    state = { ...state, scores: { ns: 0, ew: 100 } }
    state = placeBid(state, 'east', 3) // east bids (ew first)
    state = placeBid(state, 'south', 'blind_nil') // south bids blind nil (ns first)
    state = placeBid(state, 'west', 3) // west bids (ew second)
    state = placeBid(state, 'north', 5) // north bids (ns second)
    assert.equal(state.phase, 'blind_nil_exchange')
  })

  it('rejects invalid bid value', () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.throws(() => placeBid(state, 'east', 14), /invalid bid/i)
  })

  it('rejects blind nil when team is not 100+ behind', () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.throws(() => placeBid(state, 'east', 'blind_nil'), /not eligible/i)
  })

  it('rejects second blind nil for same team', () => {
    let state = createGame('table-1', PLAYER_IDS)
    // NS must be 100+ behind EW for NS players to bid blind nil
    state = { ...state, scores: { ns: 0, ew: 100 } }
    // Bidding order: east, south, west, north (north is dealer)
    state = placeBid(state, 'east', 3) // east bids
    state = placeBid(state, 'south', 'blind_nil') // south (NS first bidder) bids blind nil
    state = placeBid(state, 'west', 3) // west bids
    // North (NS second bidder) tries to also bid blind nil — should be rejected
    assert.throws(() => placeBid(state, 'north', 'blind_nil'), /already bid blind nil/i)
  })
})

describe('playCard', () => {
  function getToPlayingPhase() {
    let state = createGame('table-1', PLAYER_IDS)
    state = bidAll(state, [
      ['east', 3],
      ['south', 4],
      ['west', 3],
      ['north', 7],
    ])
    return state
  }

  it('throws if not in playing phase', () => {
    const state = createGame('table-1', PLAYER_IDS)
    const card = state.hands.east[0]
    assert.throws(() => playCard(state, 'east', card), /not in playing phase/i)
  })

  it('throws if wrong player plays', () => {
    let state = getToPlayingPhase()
    const wrongCard = state.hands.north[0]
    // East leads the first trick after north deals
    assert.throws(() => playCard(state, 'north', wrongCard), /not your turn/i)
  })

  it('throws if card not in hand', () => {
    let state = getToPlayingPhase()
    // Use a card from north's hand — since all 52 cards are dealt to exactly one
    // player, any card in north's hand is guaranteed not to be in east's hand.
    // Hardcoding a specific card (e.g. 2♠) is unreliable because the shuffle is
    // random and east holds the 2♠ ~25% of the time, causing this test to fail
    // intermittently with "Illegal play" instead of "not in hand".
    const cardNotInEastsHand = state.hands.north[0]
    assert.throws(
      () => playCard(state, 'east', cardNotInEastsHand),
      /not in hand|invalid card/i,
    )
  })

  it('removes played card from hand', () => {
    let state = getToPlayingPhase()
    const card = state.hands.east[0]
    state = playCard(state, 'east', card)
    assert.equal(state.hands.east.length, 12)
    assert.ok(!state.hands.east.some((c) => c.suit === card.suit && c.rank === card.rank))
  })

  it('spades are broken when first spade is played', () => {
    let state = getToPlayingPhase()
    assert.equal(state.spadesbroken, false)

    // Find a player who can legally play a spade (i.e., has no other option when following)
    // Simpler: inject a known hand state for testing
    // Force a situation where east has only spades
    state = {
      ...state,
      hands: {
        ...state.hands,
        east: [{ suit: 'spades', rank: 'A' }],
      },
    }
    state = playCard(state, 'east', { suit: 'spades', rank: 'A' })
    assert.equal(state.spadesbroken, true)
  })
})

describe('getPlayerView', () => {
  it('includes only the requesting player\'s hand', () => {
    const state = createGame('table-1', PLAYER_IDS)
    const view = getPlayerView(state, 'north')
    assert.ok(view.myHand)
    assert.equal(view.myHand.length, 13)
    assert.ok(!view.hands, 'should not expose all hands')
  })

  it('does not expose other players\' hands', () => {
    const state = createGame('table-1', PLAYER_IDS)
    const view = getPlayerView(state, 'north')
    assert.ok(!view.hands || !view.hands.east, 'should not expose other players hands')
  })
})

describe('CLOCKWISE_SEATS', () => {
  it('lists seats in clockwise order starting from north', () => {
    assert.deepEqual(CLOCKWISE_SEATS, ['north', 'east', 'south', 'west'])
  })
})
