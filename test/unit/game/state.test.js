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
    assert.throws(
      () => playCard(state, 'east', { suit: 'spades', rank: '2' }),
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

describe('dealer rotation', () => {
  const SEATS = ['north', 'east', 'south', 'west']

  function nextSeatClockwise(seat) {
    return SEATS[(SEATS.indexOf(seat) + 1) % 4]
  }

  /**
   * Fast-forward one complete hand by:
   * 1. Placing bids (all numeric, no nils — avoids blind nil exchange complexity)
   * 2. Injecting a controlled last-trick state (12 tricks already done)
   * 3. Playing the 4 cards of the final trick (lead player wins with Ace of clubs)
   *
   * Scores stay well within [-250, 250] across 4 successive hands so no game-over
   * is triggered.
   */
  function completeOneHand(state) {
    const dealer = state.dealerSeat
    const lead = nextSeatClockwise(dealer)
    const second = nextSeatClockwise(lead)
    const third = nextSeatClockwise(second)

    // Bidding order: lead, second, third, dealer
    // Each team's second bidder sets the team total.
    // These numbers keep NS/EW scores within safe range across all 4 rotations.
    let s = bidAll(state, [
      [lead, 3],
      [second, 6],
      [third, 6],
      [dealer, 9],
    ])

    // Give each seat one unique club card; lead seat gets Ace (guaranteed trick win)
    const lowRanks = { north: '2', east: '3', south: '4', west: '5' }
    const hands = {}
    for (const seat of SEATS) {
      hands[seat] = [{ suit: 'clubs', rank: lowRanks[seat] }]
    }
    hands[lead] = [{ suit: 'clubs', rank: 'A' }]

    s = {
      ...s,
      phase: 'playing',
      hands,
      completedTricks: Array.from({ length: 12 }, () => ({ winner: 'north', plays: [] })),
      tricksWon: { north: 3, east: 3, south: 3, west: 3 },
      currentPlayerSeat: lead,
      leadSeat: lead,
      isFirstTrick: false,
      spadesbroken: true,
      currentTrick: [],
    }

    // Play the last trick clockwise from the lead seat
    const playOrder = [lead, second, third, dealer]
    for (const seat of playOrder) {
      s = playCard(s, seat, s.hands[seat][0])
    }
    return s
  }

  it('dealer rotates clockwise after each hand', () => {
    let state = createGame('table-1', PLAYER_IDS)
    const expectedDealers = ['north', 'east', 'south', 'west', 'north']

    for (let hand = 0; hand < 4; hand++) {
      assert.equal(
        state.dealerSeat,
        expectedDealers[hand],
        `hand ${hand + 1}: expected dealer ${expectedDealers[hand]}`,
      )
      state = completeOneHand(state)
    }

    // After 4 hands the button wraps back to north
    assert.equal(state.dealerSeat, expectedDealers[4], 'dealer wraps back to north after 4 hands')
  })

  it('first bidder is always to the left of the dealer', () => {
    let state = createGame('table-1', PLAYER_IDS)

    // Hand 1: north deals → east bids first
    assert.equal(state.currentBidderSeat, 'east')
    state = completeOneHand(state)

    // Hand 2: east deals → south bids first
    assert.equal(state.currentBidderSeat, 'south')
    state = completeOneHand(state)

    // Hand 3: south deals → west bids first
    assert.equal(state.currentBidderSeat, 'west')
    state = completeOneHand(state)

    // Hand 4: west deals → north bids first
    assert.equal(state.currentBidderSeat, 'north')
  })
})
