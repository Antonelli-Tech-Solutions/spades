import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GAME_REFRESH_EVENTS, FULL_REFRESH_EVENTS, DELTA_EVENTS, applyDelta } from '../../../client/web/src/screens/game.js'

// ---------------------------------------------------------------------------
// GAME_REFRESH_EVENTS (backward-compat union)
// ---------------------------------------------------------------------------

describe('GAME_REFRESH_EVENTS', { timeout: 2000 }, () => {
  it('is exported as a Set', { timeout: 2000 }, () => {
    assert.ok(GAME_REFRESH_EVENTS instanceof Set, 'GAME_REFRESH_EVENTS should be a Set')
  })

  // PRD §6.4.3 in-game events — all must trigger a state refresh
  const requiredInGameEvents = [
    'HAND_DEALT',
    'BID_PLACED',
    'HAND_REVEALED',
    'BLIND_NIL_EXCHANGE_PROMPT',
    'CARD_PLAYED',
    'TRICK_COMPLETE',
    'HAND_SCORED',
    'GAME_OVER',
    'TURN_CHANGED',
    'PLAYER_DISCONNECTED',
    'PLAYER_RECONNECTED',
  ]

  for (const event of requiredInGameEvents) {
    it(`includes in-game event ${event}`, { timeout: 2000 }, () => {
      assert.ok(GAME_REFRESH_EVENTS.has(event), `${event} should trigger a state refresh`)
    })
  }

  // PRD §6.4.4 lobby/pre-game events — needed so the waiting-room phase stays live
  const requiredLobbyEvents = [
    'TABLE_UPDATED',
    'SEAT_TAKEN',
    'SEAT_VACATED',
    'GAME_STARTED',
  ]

  for (const event of requiredLobbyEvents) {
    it(`includes lobby/pre-game event ${event}`, { timeout: 2000 }, () => {
      assert.ok(GAME_REFRESH_EVENTS.has(event), `${event} should trigger a state refresh`)
    })
  }

  it('does not include WebSocket handshake events (JOINED, JOIN_DENIED)', { timeout: 2000 }, () => {
    assert.ok(!GAME_REFRESH_EVENTS.has('JOINED'), 'JOINED is consumed by createGameSocket internally')
    assert.ok(!GAME_REFRESH_EVENTS.has('JOIN_DENIED'), 'JOIN_DENIED is consumed by createGameSocket internally')
  })
})

// ---------------------------------------------------------------------------
// FULL_REFRESH_EVENTS — structural transitions that need a full state fetch
// ---------------------------------------------------------------------------

describe('FULL_REFRESH_EVENTS', { timeout: 2000 }, () => {
  it('is exported as a Set', { timeout: 2000 }, () => {
    assert.ok(FULL_REFRESH_EVENTS instanceof Set, 'FULL_REFRESH_EVENTS should be a Set')
  })

  const expected = ['HAND_DEALT', 'HAND_SCORED', 'GAME_OVER', 'GAME_STARTED', 'TABLE_UPDATED', 'SEAT_TAKEN', 'SEAT_VACATED']
  for (const event of expected) {
    it(`includes ${event}`, { timeout: 2000 }, () => {
      assert.ok(FULL_REFRESH_EVENTS.has(event), `${event} should be a full-refresh event`)
    })
  }

  it('does not include delta events', { timeout: 2000 }, () => {
    const deltaOnlyEvents = ['CARD_PLAYED', 'BID_PLACED', 'TRICK_COMPLETE', 'TURN_CHANGED']
    for (const event of deltaOnlyEvents) {
      assert.ok(!FULL_REFRESH_EVENTS.has(event), `${event} should not be in FULL_REFRESH_EVENTS`)
    }
  })
})

// ---------------------------------------------------------------------------
// DELTA_EVENTS — in-flight events handled via payload delta
// ---------------------------------------------------------------------------

describe('DELTA_EVENTS', { timeout: 2000 }, () => {
  it('is exported as a Set', { timeout: 2000 }, () => {
    assert.ok(DELTA_EVENTS instanceof Set, 'DELTA_EVENTS should be a Set')
  })

  const expected = [
    'CARD_PLAYED',
    'BID_PLACED',
    'TRICK_COMPLETE',
    'TURN_CHANGED',
    'HAND_REVEALED',
    'BLIND_NIL_EXCHANGE_PROMPT',
    'PLAYER_DISCONNECTED',
    'PLAYER_RECONNECTED',
  ]
  for (const event of expected) {
    it(`includes ${event}`, { timeout: 2000 }, () => {
      assert.ok(DELTA_EVENTS.has(event), `${event} should be a delta event`)
    })
  }

  it('does not include full-refresh events', { timeout: 2000 }, () => {
    const fullRefreshOnly = ['HAND_DEALT', 'HAND_SCORED', 'GAME_OVER', 'GAME_STARTED']
    for (const event of fullRefreshOnly) {
      assert.ok(!DELTA_EVENTS.has(event), `${event} should not be in DELTA_EVENTS`)
    }
  })

  it('GAME_REFRESH_EVENTS is the union of FULL_REFRESH_EVENTS and DELTA_EVENTS', { timeout: 2000 }, () => {
    for (const event of FULL_REFRESH_EVENTS) {
      assert.ok(GAME_REFRESH_EVENTS.has(event), `${event} from FULL_REFRESH_EVENTS should be in GAME_REFRESH_EVENTS`)
    }
    for (const event of DELTA_EVENTS) {
      assert.ok(GAME_REFRESH_EVENTS.has(event), `${event} from DELTA_EVENTS should be in GAME_REFRESH_EVENTS`)
    }
  })
})

// ---------------------------------------------------------------------------
// applyDelta — state patch function for in-flight delta events
// ---------------------------------------------------------------------------

describe('applyDelta', { timeout: 2000 }, () => {
  const playerId = 'player-north'
  const baseState = {
    phase: 'playing',
    players: { north: playerId, east: 'player-east', south: 'player-south', west: 'player-west' },
    bids: { north: 3, east: 4, south: 3, west: 4 },
    teamBids: { ns: 3, ew: 4 },
    currentPlayerSeat: 'north',
    currentBidderSeat: null,
    currentTrick: [],
    completedTricks: [],
    tricksWon: { north: 0, east: 0, south: 0, west: 0 },
    spadesbroken: false,
    myHand: [
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: 'K' },
      { suit: 'clubs', rank: '7' },
    ],
    handHistory: [],
    blindNilEligible: false,
    blindNilExchange: null,
  }

  it('returns state unchanged for unknown event types', { timeout: 2000 }, () => {
    const result = applyDelta(baseState, { type: 'UNKNOWN', payload: {} }, playerId)
    assert.strictEqual(result, baseState)
  })

  it('returns state unchanged when state is null', { timeout: 2000 }, () => {
    const result = applyDelta(null, { type: 'CARD_PLAYED', payload: {} }, playerId)
    assert.strictEqual(result, null)
  })

  describe('CARD_PLAYED', { timeout: 2000 }, () => {
    it('updates currentTrick, currentPlayerSeat, and spadesbroken', { timeout: 2000 }, () => {
      const trick = [{ seat: 'north', card: { suit: 'hearts', rank: 'K' } }]
      const result = applyDelta(baseState, {
        type: 'CARD_PLAYED',
        payload: {
          seat: 'north',
          card: { suit: 'hearts', rank: 'K' },
          currentTrick: trick,
          nextPlayerSeat: 'east',
          spadesBroken: false,
        },
      }, playerId)
      assert.deepEqual(result.currentTrick, trick)
      assert.equal(result.currentPlayerSeat, 'east')
      assert.equal(result.spadesbroken, false)
    })

    it('removes played card from myHand when it is the current player\'s card', { timeout: 2000 }, () => {
      const card = { suit: 'hearts', rank: 'K' }
      const result = applyDelta(baseState, {
        type: 'CARD_PLAYED',
        payload: {
          seat: 'north',
          card,
          currentTrick: [{ seat: 'north', card }],
          nextPlayerSeat: 'east',
          spadesBroken: false,
        },
      }, playerId)
      assert.ok(Array.isArray(result.myHand))
      assert.equal(result.myHand.length, baseState.myHand.length - 1)
      assert.ok(!result.myHand.some((c) => c.suit === 'hearts' && c.rank === 'K'))
    })

    it('does not remove card from myHand when another player played', { timeout: 2000 }, () => {
      const result = applyDelta(baseState, {
        type: 'CARD_PLAYED',
        payload: {
          seat: 'east',
          card: { suit: 'clubs', rank: '5' },
          currentTrick: [{ seat: 'east', card: { suit: 'clubs', rank: '5' } }],
          nextPlayerSeat: 'south',
          spadesBroken: false,
        },
      }, playerId)
      assert.deepEqual(result.myHand, baseState.myHand)
    })

    it('sets spadesbroken to true when a spade is played', { timeout: 2000 }, () => {
      const result = applyDelta(baseState, {
        type: 'CARD_PLAYED',
        payload: {
          seat: 'east',
          card: { suit: 'spades', rank: '2' },
          currentTrick: [{ seat: 'east', card: { suit: 'spades', rank: '2' } }],
          nextPlayerSeat: 'south',
          spadesBroken: true,
        },
      }, playerId)
      assert.equal(result.spadesbroken, true)
    })

    it('sets validCards when nextPlayerSeat is the current player', { timeout: 2000 }, () => {
      // East played a heart; north (me) is next to follow suit or play off-suit
      const trick = [{ seat: 'east', card: { suit: 'hearts', rank: '7' } }]
      const result = applyDelta(baseState, {
        type: 'CARD_PLAYED',
        payload: {
          seat: 'east',
          card: { suit: 'hearts', rank: '7' },
          currentTrick: trick,
          nextPlayerSeat: 'north',
          spadesBroken: false,
        },
      }, playerId)
      // myHand has a heart (K), so only that card should be legal
      assert.ok(Array.isArray(result.validCards), 'validCards should be an array')
      assert.ok(result.validCards.some((c) => c.suit === 'hearts' && c.rank === 'K'),
        'should include the heart from hand (must follow suit)')
      assert.ok(!result.validCards.some((c) => c.suit === 'spades'),
        'should not include spades when hearts can be followed')
    })

    it('clears validCards when nextPlayerSeat is another player', { timeout: 2000 }, () => {
      const trick = [{ seat: 'north', card: { suit: 'hearts', rank: 'K' } }]
      const result = applyDelta({ ...baseState, validCards: [{ suit: 'hearts', rank: 'K' }] }, {
        type: 'CARD_PLAYED',
        payload: {
          seat: 'north',
          card: { suit: 'hearts', rank: 'K' },
          currentTrick: trick,
          nextPlayerSeat: 'east',
          spadesBroken: false,
        },
      }, playerId)
      assert.equal(result.validCards, undefined)
    })

    it('excludes spades from validCards when spades not broken and leading', { timeout: 2000 }, () => {
      // Three cards played — north (me) wins and will lead next (treat 4-card trick as empty)
      const fourCardTrick = [
        { seat: 'east', card: { suit: 'hearts', rank: '7' } },
        { seat: 'south', card: { suit: 'hearts', rank: '2' } },
        { seat: 'west', card: { suit: 'hearts', rank: '3' } },
        { seat: 'north', card: { suit: 'hearts', rank: 'K' } },
      ]
      const stateWithSpadeTrick = { ...baseState, completedTricks: [{ winner: 'east', plays: [] }] }
      const result = applyDelta(stateWithSpadeTrick, {
        type: 'CARD_PLAYED',
        payload: {
          seat: 'north',
          card: { suit: 'hearts', rank: 'K' },
          currentTrick: fourCardTrick,
          nextPlayerSeat: 'north',
          spadesBroken: false,
        },
      }, playerId)
      // Player is about to lead; spades not broken — spade A should be excluded
      assert.ok(Array.isArray(result.validCards))
      assert.ok(!result.validCards.some((c) => c.suit === 'spades'),
        'should exclude spades when not broken and player is leading')
    })
  })

  describe('BID_PLACED', { timeout: 2000 }, () => {
    const biddingState = {
      ...baseState,
      phase: 'bidding',
      bids: { north: null, east: null, south: null, west: null },
      currentBidderSeat: 'north',
      currentPlayerSeat: null,
    }

    it('applies nil bid to state', { timeout: 2000 }, () => {
      const result = applyDelta(biddingState, {
        type: 'BID_PLACED',
        payload: { seat: 'north', bidType: 'nil' },
      }, playerId)
      assert.equal(result.bids.north, 'nil')
    })

    it('applies blind_nil bid to state', { timeout: 2000 }, () => {
      const result = applyDelta(biddingState, {
        type: 'BID_PLACED',
        payload: { seat: 'east', bidType: 'blindNil' },
      }, playerId)
      assert.equal(result.bids.east, 'blind_nil')
    })

    it('applies numeric bid value when bid field is present', { timeout: 2000 }, () => {
      const result = applyDelta(biddingState, {
        type: 'BID_PLACED',
        payload: { seat: 'north', bidType: 'number', bid: 3 },
      }, playerId)
      assert.equal(result.bids.north, 3)
    })

    it('leaves bid unchanged when bidType is number but bid field is missing', { timeout: 2000 }, () => {
      const result = applyDelta(biddingState, {
        type: 'BID_PLACED',
        payload: { seat: 'north', bidType: 'number' },
      }, playerId)
      assert.equal(result.bids.north, null)
    })

    it('does not mutate other seats\' bids', { timeout: 2000 }, () => {
      const result = applyDelta(biddingState, {
        type: 'BID_PLACED',
        payload: { seat: 'north', bidType: 'number', bid: 3 },
      }, playerId)
      assert.equal(result.bids.east, null)
      assert.equal(result.bids.south, null)
      assert.equal(result.bids.west, null)
    })
  })

  describe('TRICK_COMPLETE', { timeout: 2000 }, () => {
    const playingState = {
      ...baseState,
      currentTrick: [
        { seat: 'north', card: { suit: 'hearts', rank: 'K' } },
        { seat: 'east', card: { suit: 'hearts', rank: '7' } },
        { seat: 'south', card: { suit: 'hearts', rank: 'Q' } },
        { seat: 'west', card: { suit: 'hearts', rank: '2' } },
      ],
      completedTricks: [],
      tricksWon: { north: 0, east: 0, south: 0, west: 0 },
    }

    it('clears currentTrick', { timeout: 2000 }, () => {
      const result = applyDelta(playingState, {
        type: 'TRICK_COMPLETE',
        payload: {
          winnerSeat: 'north',
          plays: playingState.currentTrick,
        },
      }, playerId)
      assert.deepEqual(result.currentTrick, [])
    })

    it('adds the completed trick to completedTricks', { timeout: 2000 }, () => {
      const result = applyDelta(playingState, {
        type: 'TRICK_COMPLETE',
        payload: {
          winnerSeat: 'north',
          plays: playingState.currentTrick,
        },
      }, playerId)
      assert.equal(result.completedTricks.length, 1)
      assert.equal(result.completedTricks[0].winner, 'north')
      assert.deepEqual(result.completedTricks[0].plays, playingState.currentTrick)
    })

    it('increments tricksWon for the winner', { timeout: 2000 }, () => {
      const result = applyDelta(playingState, {
        type: 'TRICK_COMPLETE',
        payload: {
          winnerSeat: 'north',
          plays: playingState.currentTrick,
        },
      }, playerId)
      assert.equal(result.tricksWon.north, 1)
      assert.equal(result.tricksWon.east, 0)
    })

    it('accumulates multiple tricks correctly', { timeout: 2000 }, () => {
      const stateWith1 = {
        ...playingState,
        completedTricks: [{ winner: 'east', plays: [] }],
        tricksWon: { north: 0, east: 1, south: 0, west: 0 },
        currentTrick: playingState.currentTrick,
      }
      const result = applyDelta(stateWith1, {
        type: 'TRICK_COMPLETE',
        payload: { winnerSeat: 'north', plays: playingState.currentTrick },
      }, playerId)
      assert.equal(result.completedTricks.length, 2)
      assert.equal(result.tricksWon.north, 1)
      assert.equal(result.tricksWon.east, 1)
    })

    it('uses tricksWon from payload when present (SET, not increment)', { timeout: 2000 }, () => {
      // When the server includes authoritative tricksWon in the payload,
      // the client should SET the value rather than increment.
      const result = applyDelta(playingState, {
        type: 'TRICK_COMPLETE',
        payload: {
          winnerSeat: 'north',
          plays: playingState.currentTrick,
          tricksWon: { north: 3, east: 2, south: 1, west: 1 },
        },
      }, playerId)
      assert.equal(result.tricksWon.north, 3)
      assert.equal(result.tricksWon.east, 2)
      assert.equal(result.tricksWon.south, 1)
      assert.equal(result.tricksWon.west, 1)
    })

    it('is idempotent when tricksWon is in payload — applying twice gives same result', { timeout: 2000 }, () => {
      // Regression: TRICK_COMPLETE could be replayed (e.g. WS reconnect buffer)
      // causing double-counting. With payload.tricksWon as a SET operation this is safe.
      const msg = {
        type: 'TRICK_COMPLETE',
        payload: {
          winnerSeat: 'north',
          plays: playingState.currentTrick,
          tricksWon: { north: 1, east: 0, south: 0, west: 0 },
        },
      }
      const once = applyDelta(playingState, msg, playerId)
      const twice = applyDelta(once, msg, playerId)
      assert.equal(twice.tricksWon.north, 1, 'applying TRICK_COMPLETE twice must not double-count')
      assert.equal(twice.tricksWon.east, 0)
    })

    it('sets validCards when I win the trick and will lead next', { timeout: 2000 }, () => {
      // north (me) wins — should get validCards for leading next trick
      const result = applyDelta({ ...playingState, spadesbroken: false }, {
        type: 'TRICK_COMPLETE',
        payload: { winnerSeat: 'north', plays: playingState.currentTrick },
      }, playerId)
      assert.ok(Array.isArray(result.validCards), 'validCards should be set for trick winner')
      // myHand has spades A, hearts K, clubs 7. Spades not broken → spade should be excluded.
      assert.ok(!result.validCards.some((c) => c.suit === 'spades'),
        'should exclude spades when not broken and player leads')
      assert.ok(result.validCards.some((c) => c.suit === 'hearts' || c.suit === 'clubs'),
        'should include non-spade cards')
    })

    it('clears validCards when another player wins the trick', { timeout: 2000 }, () => {
      const stateWithValidCards = { ...playingState, validCards: [{ suit: 'hearts', rank: 'K' }] }
      const result = applyDelta(stateWithValidCards, {
        type: 'TRICK_COMPLETE',
        payload: { winnerSeat: 'east', plays: playingState.currentTrick },
      }, playerId)
      assert.equal(result.validCards, undefined)
    })

    it('includes spades in validCards when spades are broken and I lead', { timeout: 2000 }, () => {
      const result = applyDelta({ ...playingState, spadesbroken: true }, {
        type: 'TRICK_COMPLETE',
        payload: { winnerSeat: 'north', plays: playingState.currentTrick },
      }, playerId)
      assert.ok(Array.isArray(result.validCards))
      // All cards should be legal when leading after spades broken
      assert.equal(result.validCards.length, playingState.myHand.length)
    })
  })

  describe('TURN_CHANGED', { timeout: 2000 }, () => {
    it('updates phase and currentPlayerSeat when phase is playing', { timeout: 2000 }, () => {
      const result = applyDelta(baseState, {
        type: 'TURN_CHANGED',
        payload: { activeSeat: 'east', phase: 'playing' },
      }, playerId)
      assert.equal(result.phase, 'playing')
      assert.equal(result.currentPlayerSeat, 'east')
      assert.equal(result.currentBidderSeat, null)
    })

    it('updates phase and currentBidderSeat when phase is bidding', { timeout: 2000 }, () => {
      const result = applyDelta(baseState, {
        type: 'TURN_CHANGED',
        payload: { activeSeat: 'north', phase: 'bidding' },
      }, playerId)
      assert.equal(result.phase, 'bidding')
      assert.equal(result.currentBidderSeat, 'north')
      assert.equal(result.currentPlayerSeat, null)
    })

    it('updates phase for blind_nil_exchange without overwriting activeSeat', { timeout: 2000 }, () => {
      const result = applyDelta(baseState, {
        type: 'TURN_CHANGED',
        payload: { activeSeat: 'south', phase: 'blind_nil_exchange' },
      }, playerId)
      assert.equal(result.phase, 'blind_nil_exchange')
    })
  })

  describe('HAND_REVEALED', { timeout: 2000 }, () => {
    it('sets myHand from the payload', { timeout: 2000 }, () => {
      const newHand = [{ suit: 'spades', rank: 'A' }, { suit: 'clubs', rank: '5' }]
      const state = { ...baseState, myHand: null, blindNilEligible: true }
      const result = applyDelta(state, {
        type: 'HAND_REVEALED',
        payload: { myHand: newHand, seat: 'north' },
      }, playerId)
      assert.deepEqual(result.myHand, newHand)
      assert.equal(result.blindNilEligible, false)
    })
  })

  describe('BLIND_NIL_EXCHANGE_PROMPT', { timeout: 2000 }, () => {
    it('updates phase and blindNilExchange when step and currentBlindNilSeat are present', { timeout: 2000 }, () => {
      const result = applyDelta(baseState, {
        type: 'BLIND_NIL_EXCHANGE_PROMPT',
        payload: {
          direction: 'send',
          count: 2,
          step: 'blind_to_partner',
          currentBlindNilSeat: 'north',
        },
      }, playerId)
      assert.equal(result.phase, 'blind_nil_exchange')
      assert.equal(result.blindNilExchange.step, 'blind_to_partner')
      assert.equal(result.blindNilExchange.currentBlindNilSeat, 'north')
    })

    it('returns state unchanged if step/currentBlindNilSeat are missing (old server)', { timeout: 2000 }, () => {
      const result = applyDelta(baseState, {
        type: 'BLIND_NIL_EXCHANGE_PROMPT',
        payload: { direction: 'send', count: 2 },
      }, playerId)
      assert.strictEqual(result, baseState)
    })
  })

  describe('PLAYER_DISCONNECTED / PLAYER_RECONNECTED', { timeout: 2000 }, () => {
    it('returns state reference unchanged for PLAYER_DISCONNECTED', { timeout: 2000 }, () => {
      const result = applyDelta(baseState, {
        type: 'PLAYER_DISCONNECTED',
        payload: { seat: 'east', reconnectWindowSeconds: 60 },
      }, playerId)
      assert.strictEqual(result, baseState)
    })

    it('returns state reference unchanged for PLAYER_RECONNECTED', { timeout: 2000 }, () => {
      const result = applyDelta(baseState, {
        type: 'PLAYER_RECONNECTED',
        payload: { seat: 'east' },
      }, playerId)
      assert.strictEqual(result, baseState)
    })
  })
})
