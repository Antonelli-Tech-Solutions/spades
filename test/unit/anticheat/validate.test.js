import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateCardPlay, validateBidTurn } from '../../../server/anticheat/validate.js'

/**
 * Build a minimal game state for anticheat validation tests.
 * All omitted fields default to values that do not trigger unrelated errors.
 */
function makeState(overrides = {}) {
  return {
    phase: 'playing',
    currentPlayerSeat: 'east',
    currentTrick: [],
    spadesbroken: false,
    isFirstTrick: true,
    hands: {
      east: [
        { suit: 'clubs', rank: 'A' },
        { suit: 'hearts', rank: '7' },
        { suit: 'spades', rank: 'K' },
      ],
    },
    ...overrides,
  }
}

describe('validateCardPlay — phase and turn checks', { timeout: 2000 }, () => {
  it('throws INVALID_ACTION when game is not in playing phase', { timeout: 2000 }, () => {
    const state = makeState({ phase: 'bidding' })
    const err = assert.throws(
      () => validateCardPlay(state, 'east', { suit: 'clubs', rank: 'A' }),
      (e) => e.code === 'INVALID_ACTION',
    )
  })

  it('throws NOT_YOUR_TURN when it is not the player\'s turn', { timeout: 2000 }, () => {
    const state = makeState({ currentPlayerSeat: 'north' })
    assert.throws(
      () => validateCardPlay(state, 'east', { suit: 'clubs', rank: 'A' }),
      (e) => e.code === 'NOT_YOUR_TURN',
    )
  })

  it('throws CARD_NOT_IN_HAND when player tries to play a card they do not hold', { timeout: 2000 }, () => {
    const state = makeState()
    assert.throws(
      () => validateCardPlay(state, 'east', { suit: 'diamonds', rank: '2' }),
      (e) => e.code === 'CARD_NOT_IN_HAND',
    )
  })
})

describe('validateCardPlay — no Spade lead on first trick', { timeout: 2000 }, () => {
  it('allows leading a non-spade on the first trick', { timeout: 2000 }, () => {
    const state = makeState()
    assert.doesNotThrow(() =>
      validateCardPlay(state, 'east', { suit: 'clubs', rank: 'A' }),
    )
  })

  it('rejects leading a spade on the first trick when non-spades are available', { timeout: 2000 }, () => {
    const state = makeState()
    // East has clubs, hearts, and spades — leading spades is illegal
    assert.throws(
      () => validateCardPlay(state, 'east', { suit: 'spades', rank: 'K' }),
      (e) => e.code === 'ILLEGAL_PLAY',
    )
  })

  it('allows leading a spade on the first trick when hand contains only spades', { timeout: 2000 }, () => {
    const state = makeState({
      hands: {
        east: [
          { suit: 'spades', rank: 'A' },
          { suit: 'spades', rank: '2' },
        ],
      },
    })
    assert.doesNotThrow(() =>
      validateCardPlay(state, 'east', { suit: 'spades', rank: 'A' }),
    )
  })

  it('rejects playing a spade on the first trick when following (void in led suit) and non-spades exist', { timeout: 2000 }, () => {
    // A heart was led; east has no hearts but has clubs and spades
    const state = makeState({
      currentTrick: [{ seat: 'north', card: { suit: 'hearts', rank: 'Q' } }],
      hands: {
        east: [
          { suit: 'clubs', rank: '5' },
          { suit: 'spades', rank: 'K' },
        ],
      },
    })
    assert.throws(
      () => validateCardPlay(state, 'east', { suit: 'spades', rank: 'K' }),
      (e) => e.code === 'ILLEGAL_PLAY',
    )
  })

  it('allows playing a spade on the first trick when following and only spades remain after exhausting led suit', { timeout: 2000 }, () => {
    // A heart was led; east has only spades left — must play spades
    const state = makeState({
      currentTrick: [{ seat: 'north', card: { suit: 'hearts', rank: 'Q' } }],
      hands: {
        east: [{ suit: 'spades', rank: 'K' }],
      },
    })
    assert.doesNotThrow(() =>
      validateCardPlay(state, 'east', { suit: 'spades', rank: 'K' }),
    )
  })

  it('enforces suit-following on the first trick (must follow led suit if able)', { timeout: 2000 }, () => {
    // A clubs was led; east has a clubs — must follow suit, cannot play hearts
    const state = makeState({
      currentTrick: [{ seat: 'north', card: { suit: 'clubs', rank: '2' } }],
      hands: {
        east: [
          { suit: 'clubs', rank: 'A' },
          { suit: 'hearts', rank: '7' },
        ],
      },
    })
    assert.throws(
      () => validateCardPlay(state, 'east', { suit: 'hearts', rank: '7' }),
      (e) => e.code === 'ILLEGAL_PLAY',
    )
  })
})

describe('validateBidTurn — phase and turn checks', { timeout: 2000 }, () => {
  function makeBidState(overrides = {}) {
    return {
      phase: 'bidding',
      currentBidderSeat: 'north',
      ...overrides,
    }
  }

  it('throws INVALID_ACTION when game is not in bidding phase', { timeout: 2000 }, () => {
    const state = makeBidState({ phase: 'playing' })
    assert.throws(
      () => validateBidTurn(state, 'north'),
      (e) => e.code === 'INVALID_ACTION',
    )
  })

  it('throws NOT_YOUR_TURN when it is not the player\'s turn to bid', { timeout: 2000 }, () => {
    const state = makeBidState({ currentBidderSeat: 'east' })
    assert.throws(
      () => validateBidTurn(state, 'north'),
      (e) => e.code === 'NOT_YOUR_TURN',
    )
  })

  it('does not throw when phase is bidding and it is the player\'s turn', { timeout: 2000 }, () => {
    const state = makeBidState()
    assert.doesNotThrow(() => validateBidTurn(state, 'north'))
  })
})

describe('validateCardPlay — Spades breaking (subsequent tricks)', { timeout: 2000 }, () => {
  it('rejects leading a spade before spades are broken when non-spades are available', { timeout: 2000 }, () => {
    const state = makeState({
      isFirstTrick: false,
      spadesbroken: false,
      currentTrick: [],
      hands: {
        east: [
          { suit: 'clubs', rank: 'A' },
          { suit: 'spades', rank: 'K' },
        ],
      },
    })
    assert.throws(
      () => validateCardPlay(state, 'east', { suit: 'spades', rank: 'K' }),
      (e) => e.code === 'ILLEGAL_PLAY',
    )
  })

  it('allows leading a spade after spades are broken', { timeout: 2000 }, () => {
    const state = makeState({
      isFirstTrick: false,
      spadesbroken: true,
      currentTrick: [],
      hands: {
        east: [
          { suit: 'clubs', rank: 'A' },
          { suit: 'spades', rank: 'K' },
        ],
      },
    })
    assert.doesNotThrow(() =>
      validateCardPlay(state, 'east', { suit: 'spades', rank: 'K' }),
    )
  })

  it('allows playing any card on non-first trick when void in led suit', { timeout: 2000 }, () => {
    const state = makeState({
      isFirstTrick: false,
      spadesbroken: false,
      currentTrick: [{ seat: 'north', card: { suit: 'hearts', rank: 'Q' } }],
      hands: {
        east: [
          { suit: 'clubs', rank: '5' },
          { suit: 'spades', rank: 'K' },
        ],
      },
    })
    // Void in hearts — may play spades (even before broken) or clubs
    assert.doesNotThrow(() =>
      validateCardPlay(state, 'east', { suit: 'spades', rank: 'K' }),
    )
  })
})
