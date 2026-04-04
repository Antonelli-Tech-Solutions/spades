import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGame,
  placeBid,
  playCard,
  submitBlindNilExchange,
  getPlayerView,
  advanceBotTurns,
  substitutePlayerWithBot,
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

describe('createGame', { timeout: 2000 }, () => {
  it('creates a game in bidding phase', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.equal(state.phase, 'bidding')
  })

  it('deals 13 cards to each player', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    for (const seat of CLOCKWISE_SEATS) {
      assert.equal(state.hands[seat].length, 13)
    }
  })

  it('hands are sorted by suit then rank', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    for (const seat of CLOCKWISE_SEATS) {
      const hand = state.hands[seat]
      for (let i = 1; i < hand.length; i++) {
        const prev = hand[i - 1]
        const curr = hand[i]
        const suitOrder = ['spades', 'hearts', 'clubs', 'diamonds']
        const rankOrder = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
        if (prev.suit === curr.suit) {
          assert.ok(
            rankOrder.indexOf(prev.rank) >= rankOrder.indexOf(curr.rank),
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

  it('north is the dealer on the first hand', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.equal(state.dealerSeat, 'north')
  })

  it('first bidder is east (left of north dealer)', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.equal(state.currentBidderSeat, 'east')
  })

  it('initialises scores and bags to zero', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.deepEqual(state.scores, { ns: 0, ew: 0 })
    assert.deepEqual(state.bags, { ns: 0, ew: 0 })
  })
})

describe('placeBid', { timeout: 2000 }, () => {
  it('throws if not in bidding phase', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    // Manually set phase
    const badState = { ...state, phase: 'playing' }
    assert.throws(() => placeBid(badState, 'east', 3), /not in bidding phase/i)
  })

  it('throws if wrong player bids', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.throws(() => placeBid(state, 'north', 3), /not your turn/i)
  })

  it('records the bid and advances to next bidder', { timeout: 2000 }, () => {
    let state = createGame('table-1', PLAYER_IDS)
    state = placeBid(state, 'east', 3)
    assert.equal(state.bids.east, 3)
    assert.equal(state.currentBidderSeat, 'south')
  })

  it('transitions to playing phase after all 4 bids', { timeout: 2000 }, () => {
    let state = createGame('table-1', PLAYER_IDS)
    state = bidAll(state, [
      ['east', 3],
      ['south', 4],
      ['west', 3],
      ['north', 7],
    ])
    assert.equal(state.phase, 'playing')
  })

  it('second bidder number becomes the team bid — first bidder is advisory only', { timeout: 2000 }, () => {
    // North deals → bidding order: east, south, west, north
    // EW: east bids first (advisory 4), west bids second (sets team total to 7)
    // NS: south bids first (advisory 3), north bids second (sets team total to 5)
    // PRD §5.2 example: "North bids 4. South bids 7. The team target is 7."
    let state = createGame('table-1', PLAYER_IDS)
    state = bidAll(state, [
      ['east', 4],
      ['south', 3],
      ['west', 7],
      ['north', 5],
    ])
    assert.equal(state.teamBids.ew, 7)
    assert.equal(state.teamBids.ns, 5)
  })

  it('second bidder can set team total lower than first bidder advisory number', { timeout: 2000 }, () => {
    // PRD §5.2: "The team's combined bid may be lower than the first bidder's individual bid."
    let state = createGame('table-1', PLAYER_IDS)
    state = bidAll(state, [
      ['east', 6],
      ['south', 3],
      ['west', 4],
      ['north', 5],
    ])
    assert.equal(state.teamBids.ew, 4) // team bid is 4, not east's advisory 6
  })

  it('when first bidder bids nil, second bidder number is the team target and nil stands', { timeout: 2000 }, () => {
    // East bids nil (individual bid stands), west sets team total to 5
    let state = createGame('table-1', PLAYER_IDS)
    state = bidAll(state, [
      ['east', 'nil'],
      ['south', 3],
      ['west', 5],
      ['north', 5],
    ])
    assert.equal(state.bids.east, 'nil')
    assert.equal(state.teamBids.ew, 5)
  })

  it('transitions to blind_nil_exchange when a player bids blind nil', { timeout: 2000 }, () => {
    // Make NS far behind so blind nil is eligible
    let state = createGame('table-1', PLAYER_IDS)
    state = { ...state, scores: { ns: 0, ew: 100 } }
    state = placeBid(state, 'east', 3) // east bids (ew first)
    state = placeBid(state, 'south', 'blind_nil') // south bids blind nil (ns first)
    state = placeBid(state, 'west', 3) // west bids (ew second)
    state = placeBid(state, 'north', 5) // north bids (ns second)
    assert.equal(state.phase, 'blind_nil_exchange')
  })

  it('rejects invalid bid value', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.throws(() => placeBid(state, 'east', 14), /invalid bid/i)
  })

  it('rejects blind nil when team is not 100+ behind', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    assert.throws(() => placeBid(state, 'east', 'blind_nil'), /not eligible/i)
  })

  it('rejects second blind nil for same team', { timeout: 2000 }, () => {
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

describe('playCard', { timeout: 2000 }, () => {
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

  it('throws if not in playing phase', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    const card = state.hands.east[0]
    assert.throws(() => playCard(state, 'east', card), /not in playing phase/i)
  })

  it('throws if wrong player plays', { timeout: 2000 }, () => {
    let state = getToPlayingPhase()
    const wrongCard = state.hands.north[0]
    // East leads the first trick after north deals
    assert.throws(() => playCard(state, 'north', wrongCard), /not your turn/i)
  })

  it('throws if card not in hand', { timeout: 2000 }, () => {
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

  it('removes played card from hand', { timeout: 2000 }, () => {
    let state = getToPlayingPhase()
    // east[0] may be a spade (illegal on trick 1); pick first non-spade card instead
    const card = state.hands.east.find((c) => c.suit !== 'spades')
    state = playCard(state, 'east', card)
    assert.equal(state.hands.east.length, 12)
    assert.ok(!state.hands.east.some((c) => c.suit === card.suit && c.rank === card.rank))
  })

  it('spades are broken when first spade is played (after the first trick)', { timeout: 2000 }, () => {
    let state = getToPlayingPhase()
    assert.equal(state.spadesbroken, false)

    // Inject a known hand state on trick 2 (isFirstTrick: false) where east has only a spade
    state = {
      ...state,
      isFirstTrick: false,
      hands: {
        ...state.hands,
        east: [{ suit: 'spades', rank: 'A' }],
      },
    }
    state = playCard(state, 'east', { suit: 'spades', rank: 'A' })
    assert.equal(state.spadesbroken, true)
  })
})

describe('Spades-breaking', { timeout: 2000 }, () => {
  function getPlayingState() {
    let state = createGame('table-1', PLAYER_IDS)
    return bidAll(state, [
      ['east', 3],
      ['south', 4],
      ['west', 3],
      ['north', 7],
    ])
  }

  it('playing a spade on the first trick does not break spades', { timeout: 2000 }, () => {
    // PRD §5.1: "Spades are broken by the first Spade played (after the first trick)"
    let state = getPlayingState()
    // East has only spades — legal to lead on trick 1 when player holds nothing else
    state = {
      ...state,
      isFirstTrick: true,
      currentTrick: [],
      currentPlayerSeat: 'east',
      hands: { ...state.hands, east: [{ suit: 'spades', rank: 'A' }] },
    }
    state = playCard(state, 'east', { suit: 'spades', rank: 'A' })
    assert.equal(state.spadesbroken, false)
  })

  it('playing a spade as a discard (void in led suit) breaks spades', { timeout: 2000 }, () => {
    let state = getPlayingState()
    // East has led clubs; south is void in clubs and must play their only card (a spade)
    state = {
      ...state,
      isFirstTrick: false,
      currentTrick: [{ seat: 'east', card: { suit: 'clubs', rank: '2' } }],
      currentPlayerSeat: 'south',
      hands: { ...state.hands, south: [{ suit: 'spades', rank: 'Q' }] },
    }
    state = playCard(state, 'south', { suit: 'spades', rank: 'Q' })
    assert.equal(state.spadesbroken, true)
  })

  it('attempting to lead spades before they are broken is rejected', { timeout: 2000 }, () => {
    let state = getPlayingState()
    state = {
      ...state,
      isFirstTrick: false,
      spadesbroken: false,
      currentTrick: [],
      currentPlayerSeat: 'east',
      hands: {
        ...state.hands,
        east: [{ suit: 'spades', rank: 'A' }, { suit: 'clubs', rank: '3' }],
      },
    }
    assert.throws(
      () => playCard(state, 'east', { suit: 'spades', rank: 'A' }),
      /illegal play/i,
    )
  })

  it('can lead spades once they are broken', { timeout: 2000 }, () => {
    let state = getPlayingState()
    state = {
      ...state,
      isFirstTrick: false,
      spadesbroken: true,
      currentTrick: [],
      currentPlayerSeat: 'east',
      hands: {
        ...state.hands,
        east: [{ suit: 'spades', rank: 'A' }, { suit: 'clubs', rank: '3' }],
      },
    }
    assert.doesNotThrow(() => playCard(state, 'east', { suit: 'spades', rank: 'A' }))
  })

  it('spadesbroken resets to false at the start of the next hand', { timeout: 2000 }, () => {
    let state = getPlayingState()
    // Fast-forward to the final trick of a hand with spades already broken
    state = {
      ...state,
      phase: 'playing',
      hands: {
        north: [{ suit: 'clubs', rank: '2' }],
        east: [{ suit: 'clubs', rank: 'A' }],
        south: [{ suit: 'clubs', rank: '4' }],
        west: [{ suit: 'clubs', rank: '5' }],
      },
      completedTricks: Array.from({ length: 12 }, () => ({ winner: 'north', plays: [] })),
      tricksWon: { north: 3, east: 3, south: 3, west: 3 },
      currentPlayerSeat: 'east',
      leadSeat: 'east',
      isFirstTrick: false,
      spadesbroken: true,
      currentTrick: [],
    }
    // East leads and wins the final trick with the Ace of clubs
    state = playCard(state, 'east', { suit: 'clubs', rank: 'A' })
    state = playCard(state, 'south', { suit: 'clubs', rank: '4' })
    state = playCard(state, 'west', { suit: 'clubs', rank: '5' })
    state = playCard(state, 'north', { suit: 'clubs', rank: '2' })
    // New hand starts in bidding phase with spadesbroken reset
    assert.equal(state.phase, 'bidding')
    assert.equal(state.spadesbroken, false)
  })
})

describe('getPlayerView', { timeout: 2000 }, () => {
  it('includes only the requesting player\'s hand', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    const view = getPlayerView(state, 'north')
    assert.ok(view.myHand)
    assert.equal(view.myHand.length, 13)
    assert.ok(!view.hands, 'should not expose all hands')
  })

  it('does not expose other players\' hands', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    const view = getPlayerView(state, 'north')
    assert.ok(!view.hands || !view.hands.east, 'should not expose other players hands')
  })

  it('strictly excludes the hands key for all 4 seats', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    for (const seat of ['north', 'east', 'south', 'west']) {
      const view = getPlayerView(state, seat)
      assert.ok(!('hands' in view), `hands key must be absent for ${seat}`)
    }
  })

  it('myHand exactly matches the dealt cards for each seat', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    for (const seat of ['north', 'east', 'south', 'west']) {
      const view = getPlayerView(state, seat)
      assert.deepEqual(view.myHand, state.hands[seat], `myHand must exactly match dealt hand for ${seat}`)
    }
  })

  it('each seat receives a unique hand (no two myHands share any card)', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    const seats = ['north', 'east', 'south', 'west']
    const hands = seats.map((seat) => getPlayerView(state, seat).myHand)

    // Build a set of card keys for each hand and verify no overlap
    const cardKey = (c) => `${c.suit}:${c.rank}`
    for (let i = 0; i < seats.length; i++) {
      const keysI = new Set(hands[i].map(cardKey))
      for (let j = i + 1; j < seats.length; j++) {
        const keysJ = new Set(hands[j].map(cardKey))
        for (const k of keysI) {
          assert.ok(!keysJ.has(k), `${seats[i]} and ${seats[j]} share card ${k}`)
        }
      }
    }
  })

  it('includes currentTrick in the view (public info)', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    // currentTrick is public — it must be present in the player view
    const view = getPlayerView(state, 'north')
    assert.ok('currentTrick' in view, 'currentTrick must be present in player view')
    assert.ok(Array.isArray(view.currentTrick))
  })

  it('does not expose opponent card identity through any top-level key', { timeout: 2000 }, () => {
    const state = createGame('table-1', PLAYER_IDS)
    const northView = getPlayerView(state, 'north')
    const northHandKeys = new Set(northView.myHand.map((c) => `${c.suit}:${c.rank}`))

    // Build the full set of cards belonging to other seats
    const otherCards = new Set()
    for (const seat of ['east', 'south', 'west']) {
      for (const card of state.hands[seat]) {
        otherCards.add(`${card.suit}:${card.rank}`)
      }
    }

    // None of the cards that belong to other seats should appear in northView's myHand
    for (const cardKey of northHandKeys) {
      assert.ok(!otherCards.has(cardKey), `opponent card ${cardKey} leaked into north's myHand`)
    }
  })
})

describe('CLOCKWISE_SEATS', { timeout: 2000 }, () => {
  it('lists seats in clockwise order starting from north', { timeout: 2000 }, () => {
    assert.deepEqual(CLOCKWISE_SEATS, ['north', 'east', 'south', 'west'])
  })
})

describe('bag tracking — state level', { timeout: 2000 }, () => {
  const SEATS = ['north', 'east', 'south', 'west']

  /**
   * Build a state that is one trick away from completing a hand.
   *
   * - North is dealer; bidding order: east, south, west, north
   * - EW team bid = 6 (west is second bidder); NS team bid = 7 (north is second bidder)
   * - 12 tricks are already completed with tricksWon as provided
   * - East (left of dealer) leads the 13th trick with Ace of clubs (guaranteed win)
   *
   * After playing the 4 cards of the last trick, east wins it, adding 1 to EW's count.
   */
  function buildFinalTrickState(initialScores, initialBags, tricksWon12) {
    let state = createGame('table-1', PLAYER_IDS)
    state = { ...state, scores: initialScores, bags: initialBags }

    // Bidding order: east, south, west, north
    state = placeBid(state, 'east', 2)  // EW advisory
    state = placeBid(state, 'south', 4) // NS advisory
    state = placeBid(state, 'west', 6)  // EW second bidder → team total = 6
    state = placeBid(state, 'north', 7) // NS second bidder → team total = 7

    // Give each seat one unique club card; east gets Ace (leads and wins last trick)
    const hands = {
      north: [{ suit: 'clubs', rank: '2' }],
      east:  [{ suit: 'clubs', rank: 'A' }],
      south: [{ suit: 'clubs', rank: '4' }],
      west:  [{ suit: 'clubs', rank: '5' }],
    }

    state = {
      ...state,
      phase: 'playing',
      hands,
      completedTricks: Array.from({ length: 12 }, () => ({ winner: 'north', plays: [] })),
      tricksWon: tricksWon12,
      currentPlayerSeat: 'east',
      leadSeat: 'east',
      isFirstTrick: false,
      spadesbroken: true,
      currentTrick: [],
    }

    // Play the 13th trick clockwise from east
    for (const seat of ['east', 'south', 'west', 'north']) {
      state = playCard(state, seat, state.hands[seat][0])
    }

    return state
  }

  it('bags accumulate in state after a hand with overtricks', { timeout: 2000 }, () => {
    // After 12 tricks: NS has 9, EW has 3 (east wins 13th → EW ends at 4)
    // NS bid 7 → 9 tricks → 2 overtricks → 2 bags
    // EW bid 6 → 4 tricks → missed bid (-60), 0 bags
    const state = buildFinalTrickState(
      { ns: 0, ew: 0 },
      { ns: 0, ew: 0 },
      { north: 4, east: 2, south: 5, west: 1 },
    )

    assert.equal(state.bags.ns, 2, 'NS should have 2 bags from 2 overtricks')
    assert.equal(state.bags.ew, 0, 'EW missed bid — no bags')
    assert.equal(state.scores.ns, 72, 'NS: bid 7 made 9 → +70 + 2 bags (+2 pts) = 72')
    assert.equal(state.scores.ew, -60, 'EW: bid 6 made 4 → -60')
  })

  it('applies -100 penalty and resets bag count when bags reach 10', { timeout: 2000 }, () => {
    // Start with NS at 9 bags. Hand produces 2 more overtricks → total 11 → penalty fires
    const state = buildFinalTrickState(
      { ns: 100, ew: 100 },
      { ns: 9, ew: 0 },
      { north: 4, east: 2, south: 5, west: 1 },
    )

    // NS: 100 + 72 (bid made + 2 bags) - 100 (bag penalty) = 72; bags: (9+2) % 10 = 1
    assert.equal(state.scores.ns, 72, 'NS score after bag penalty')
    assert.equal(state.bags.ns, 1, 'NS bags reset to 1 after penalty')
    // EW: 100 - 60 = 40; bags unchanged
    assert.equal(state.scores.ew, 40, 'EW score unaffected by NS bag penalty')
    assert.equal(state.bags.ew, 0, 'EW bags remain 0')
  })

  it('bags carry over correctly across two hands with no double-deduction', { timeout: 2000 }, () => {
    // Hand 1: NS gets 2 bags, EW gets 0
    let state = buildFinalTrickState(
      { ns: 0, ew: 0 },
      { ns: 0, ew: 0 },
      { north: 4, east: 2, south: 5, west: 1 },
    )

    const bagsAfterHand1 = { ...state.bags }
    const scoresAfterHand1 = { ...state.scores }

    // Verify hand 1 results
    assert.equal(bagsAfterHand1.ns, 2)
    assert.equal(scoresAfterHand1.ns, 72)

    // Hand 2: same setup — NS gets 2 more bags, total 4 (no penalty yet)
    // Bidding order for hand 2: south (east was dealer), west, north, east
    const dealer2 = state.dealerSeat // should be 'east' after north dealt hand 1
    assert.equal(dealer2, 'east', 'dealer rotates to east for hand 2')

    // Inject the same controlled end-of-hand state again with accumulated bags
    const hands2 = {
      north: [{ suit: 'clubs', rank: '2' }],
      south:  [{ suit: 'clubs', rank: 'A' }], // south is left of east dealer → leads
      west: [{ suit: 'clubs', rank: '4' }],
      east:  [{ suit: 'clubs', rank: '5' }],
    }

    // For hand 2: south leads (left of east dealer), bidding order: south, west, north, east
    // NS first bid: south (advisory), NS second: north (sets total)
    // EW first bid: west (advisory), EW second: east (sets total)
    state = placeBid(state, 'south', 4)  // NS advisory
    state = placeBid(state, 'west', 2)   // EW advisory
    state = placeBid(state, 'north', 7)  // NS second → team total = 7
    state = placeBid(state, 'east', 6)   // EW second → team total = 6

    // After 12 tricks: NS has 9, EW has 3 (south wins 13th → NS total stays 9+trick from south)
    // south leads and wins last trick (Ace of clubs) → NS gets +1 → NS ends at 9+1 = 10?
    // Wait — south wins, so NS gets 1 more: tricksWon12 = {north:4, south:5, east:2, west:1} is 12 tricks
    // south wins 13th → NS total = 4+5+1 = 10, EW = 2+1 = 3
    // But NS bid = 7 → 10 tricks → 3 overtricks → 3 more bags → total 2+3=5 bags, no penalty

    state = {
      ...state,
      phase: 'playing',
      hands: hands2,
      completedTricks: Array.from({ length: 12 }, () => ({ winner: 'north', plays: [] })),
      tricksWon: { north: 4, east: 2, south: 5, west: 1 },
      currentPlayerSeat: 'south',
      leadSeat: 'south',
      isFirstTrick: false,
      spadesbroken: true,
      currentTrick: [],
    }

    for (const seat of ['south', 'west', 'north', 'east']) {
      state = playCard(state, seat, state.hands[seat][0])
    }

    // NS: previous 2 bags + 3 new bags = 5, no penalty
    assert.equal(state.bags.ns, 5, 'bags carry over correctly — no double deduction')
    assert.ok(state.scores.ns > 0, 'no spurious bag penalty applied')
  })
})

describe('dealer rotation', { timeout: 2000 }, () => {
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

  it('dealer rotates clockwise after each hand', { timeout: 2000 }, () => {
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

  it('first bidder is always to the left of the dealer', { timeout: 2000 }, () => {
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

describe('game over — phase transition', { timeout: 2000 }, () => {
  /**
   * Build a state one trick from hand completion with fixed bids.
   * Bidding order: east, south, west, north
   *   NS team total: 7 (north is second bidder)
   *   EW team total: 6 (west is second bidder)
   * East leads and wins the 13th trick with the Ace of clubs.
   *
   * @param {{ initialScores: {ns,ew}, tricksWon12: {north,east,south,west} }} opts
   *   tricksWon12 must sum to 12 (tricks before the final one).
   */
  function buildNearEndState({ initialScores, tricksWon12 }) {
    let state = createGame('table-1', PLAYER_IDS)
    state = { ...state, scores: initialScores, bags: { ns: 0, ew: 0 } }
    // Bidding order: east, south, west, north
    state = placeBid(state, 'east', 2)   // EW advisory
    state = placeBid(state, 'south', 4)  // NS advisory
    state = placeBid(state, 'west', 6)   // EW second bidder → team total 6
    state = placeBid(state, 'north', 7)  // NS second bidder → team total 7
    const hands = {
      north: [{ suit: 'clubs', rank: '2' }],
      east:  [{ suit: 'clubs', rank: 'A' }],
      south: [{ suit: 'clubs', rank: '4' }],
      west:  [{ suit: 'clubs', rank: '5' }],
    }
    state = {
      ...state,
      phase: 'playing',
      hands,
      completedTricks: Array.from({ length: 12 }, () => ({ winner: 'north', plays: [] })),
      tricksWon: tricksWon12,
      currentPlayerSeat: 'east',
      leadSeat: 'east',
      isFirstTrick: false,
      spadesbroken: true,
      currentTrick: [],
    }
    for (const seat of ['east', 'south', 'west', 'north']) {
      state = playCard(state, seat, state.hands[seat][0])
    }
    return state
  }

  it('transitions to game_over with winner=ns when NS score reaches 250', { timeout: 2000 }, () => {
    // After hand: NS=9 tricks (north:4+south:5) vs bid 7 → +70 + 2 bags (+2 pts) = 72 → 200+72=272 ≥ 250
    //             EW=4 tricks (east:3+west:1) vs bid 6 → -60 → 100-60=40
    const state = buildNearEndState({
      initialScores: { ns: 200, ew: 100 },
      tricksWon12: { north: 4, east: 2, south: 5, west: 1 }, // sum=12
    })
    assert.equal(state.phase, 'game_over')
    assert.equal(state.winner, 'ns')
    assert.equal(state.gameOver, true)
    assert.equal(state.scores.ns, 272)
  })

  it('starts next hand in bidding phase when neither team reaches a threshold', { timeout: 2000 }, () => {
    // After hand: NS=9 vs bid 7 → +70 → 0+70=70 (< 250); EW=4 vs bid 6 → -60 (> -250)
    const state = buildNearEndState({
      initialScores: { ns: 0, ew: 0 },
      tricksWon12: { north: 4, east: 2, south: 5, west: 1 },
    })
    assert.equal(state.phase, 'bidding', 'should start the next hand')
    assert.equal(state.winner, null)
    assert.equal(state.gameOver, false)
    assert.equal(state.handNumber, 2)
  })

  it('transitions to game_over with winner=ew when NS score drops to -250 or below', { timeout: 2000 }, () => {
    // After hand: NS=3 tricks (north:1+south:2) vs bid 7 → -70 → -200-70=-270 ≤ -250
    //             EW=10 tricks (east:6+west:4) vs bid 6 → +60 + 4 bags → 100+60=160
    const state = buildNearEndState({
      initialScores: { ns: -200, ew: 100 },
      tricksWon12: { north: 1, east: 5, south: 2, west: 4 }, // sum=12
    })
    assert.equal(state.phase, 'game_over')
    assert.equal(state.winner, 'ew')
    assert.equal(state.gameOver, true)
    assert.equal(state.scores.ns, -270)
  })

  it('getPlayerView in game_over state exposes winner and scores but not all hands', { timeout: 2000 }, () => {
    const state = buildNearEndState({
      initialScores: { ns: 200, ew: 100 },
      tricksWon12: { north: 4, east: 2, south: 5, west: 1 },
    })
    const view = getPlayerView(state, 'north')
    assert.equal(view.phase, 'game_over')
    assert.equal(view.winner, 'ns')
    assert.ok('scores' in view, 'view should include scores')
    assert.ok('bags' in view, 'view should include bags')
    assert.ok(!('hands' in view), 'view must not expose the full hands object')
    assert.ok('myHand' in view, 'view must expose myHand for the requesting player')
  })
})

const HUMAN_PLAYERS = {
  north: 'player-north',
  east: 'player-east',
  south: 'player-south',
  west: 'player-west',
}

describe('substitutePlayerWithBot', { timeout: 2000 }, () => {
  it('replaces the human player with a bot at the given seat', { timeout: 2000 }, () => {
    const state = createGame('table-1', HUMAN_PLAYERS)
    const updated = substitutePlayerWithBot(state, 'east')
    assert.equal(updated.players.east, 'bot:east')
    assert.equal(updated.players.north, 'player-north')
    assert.equal(updated.players.south, 'player-south')
    assert.equal(updated.players.west, 'player-west')
  })

  it('does not mutate the original state', { timeout: 2000 }, () => {
    const state = createGame('table-1', HUMAN_PLAYERS)
    substitutePlayerWithBot(state, 'east')
    assert.equal(state.players.east, 'player-east', 'original state must not be mutated')
  })

  it('advances bot turns immediately after substitution when all remaining bidders are bots', { timeout: 2000 }, () => {
    const allBotsExceptNorth = {
      north: 'player-north',
      east: 'bot:east',
      south: 'bot:south',
      west: 'bot:west',
    }
    const state = createGame('table-1', allBotsExceptNorth)
    assert.equal(state.phase, 'bidding')
    assert.equal(state.currentBidderSeat, 'east')

    const updated = substitutePlayerWithBot(state, 'north')
    assert.notEqual(updated.phase, 'bidding', 'bidding should complete when all seats are bots')
  })
})

describe('advanceBotTurns', { timeout: 2000 }, () => {
  it('returns state unchanged when current bidder is human', { timeout: 2000 }, () => {
    const state = createGame('table-1', HUMAN_PLAYERS)
    assert.equal(state.phase, 'bidding')
    const result = advanceBotTurns(state)
    assert.equal(result.phase, 'bidding')
    assert.equal(result.currentBidderSeat, state.currentBidderSeat)
  })

  it('advances past bot bidders automatically after a human bids', { timeout: 2000 }, () => {
    const players = {
      north: 'bot:north',
      east: 'player-east',
      south: 'bot:south',
      west: 'bot:west',
    }
    let state = createGame('table-1', players)
    state = placeBid(state, 'east', 3)
    const result = advanceBotTurns(state)
    assert.notEqual(result.phase, 'bidding', 'all bot bids should be resolved')
  })
})
