import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getLegalPlays, determineTrickWinner, isCardLegal } from '../../../server/game/trick.js'

describe('getLegalPlays — leading a trick', { timeout: 2000 }, () => {
  it('allows any non-spade on the first trick of a hand', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'clubs', rank: 'A' },
      { suit: 'spades', rank: 'K' },
      { suit: 'hearts', rank: '7' },
    ]
    const legal = getLegalPlays(hand, [], false, true)
    assert.equal(legal.length, 2)
    assert.ok(legal.every((c) => c.suit !== 'spades'))
  })

  it('on the first trick, if a player has ONLY spades they must play spades', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'spades', rank: '2' },
    ]
    const legal = getLegalPlays(hand, [], false, true)
    assert.equal(legal.length, 2)
    assert.ok(legal.every((c) => c.suit === 'spades'))
  })

  it('cannot lead spades before spades are broken (and has non-spades)', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'clubs', rank: 'A' },
      { suit: 'spades', rank: 'K' },
    ]
    const legal = getLegalPlays(hand, [], false, false) // spades not broken, not first trick
    assert.equal(legal.length, 1)
    assert.equal(legal[0].suit, 'clubs')
  })

  it('can lead spades once spades are broken', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'clubs', rank: 'A' },
      { suit: 'spades', rank: 'K' },
    ]
    const legal = getLegalPlays(hand, [], true, false) // spades broken
    assert.equal(legal.length, 2)
  })

  it('can lead any card when spades not broken but player has only spades', { timeout: 2000 }, () => {
    const hand = [{ suit: 'spades', rank: 'A' }]
    const legal = getLegalPlays(hand, [], false, false)
    assert.equal(legal.length, 1)
    assert.equal(legal[0].suit, 'spades')
  })
})

describe('getLegalPlays — following a trick', { timeout: 2000 }, () => {
  it('must follow suit if possible', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'clubs', rank: 'A' },
      { suit: 'clubs', rank: '5' },
      { suit: 'spades', rank: 'K' },
    ]
    const trick = [{ seat: 'north', card: { suit: 'clubs', rank: '2' } }]
    const legal = getLegalPlays(hand, trick, false, false)
    assert.equal(legal.length, 2)
    assert.ok(legal.every((c) => c.suit === 'clubs'))
  })

  it('may play any card when unable to follow suit', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: '5' },
    ]
    const trick = [{ seat: 'north', card: { suit: 'clubs', rank: '2' } }]
    const legal = getLegalPlays(hand, trick, false, false)
    assert.equal(legal.length, 2)
  })

  it('on the first trick, cannot play spades when unable to follow suit if non-spades exist', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'hearts', rank: '5' },
      { suit: 'spades', rank: 'A' },
    ]
    const trick = [{ seat: 'north', card: { suit: 'clubs', rank: '2' } }]
    const legal = getLegalPlays(hand, trick, false, true)
    // Can't follow clubs, but on first trick can't play spades if other options exist
    assert.equal(legal.length, 1)
    assert.equal(legal[0].suit, 'hearts')
  })

  it('on the first trick, must play spades if only spades available when unable to follow suit', { timeout: 2000 }, () => {
    const hand = [{ suit: 'spades', rank: 'A' }]
    const trick = [{ seat: 'north', card: { suit: 'clubs', rank: '2' } }]
    const legal = getLegalPlays(hand, trick, false, true)
    assert.equal(legal.length, 1)
    assert.equal(legal[0].suit, 'spades')
  })
})

describe('determineTrickWinner', { timeout: 2000 }, () => {
  it('highest card of led suit wins when no spades played', { timeout: 2000 }, () => {
    const trick = [
      { seat: 'north', card: { suit: 'clubs', rank: 'A' } },
      { seat: 'east', card: { suit: 'clubs', rank: '3' } },
      { seat: 'south', card: { suit: 'hearts', rank: 'K' } }, // different suit — irrelevant
      { seat: 'west', card: { suit: 'clubs', rank: 'Q' } },
    ]
    assert.equal(determineTrickWinner(trick), 'north')
  })

  it('spade beats highest non-spade of led suit', { timeout: 2000 }, () => {
    const trick = [
      { seat: 'north', card: { suit: 'clubs', rank: 'A' } },
      { seat: 'east', card: { suit: 'spades', rank: '2' } },
      { seat: 'south', card: { suit: 'clubs', rank: 'K' } },
      { seat: 'west', card: { suit: 'clubs', rank: 'Q' } },
    ]
    assert.equal(determineTrickWinner(trick), 'east')
  })

  it('highest spade wins when multiple spades played', { timeout: 2000 }, () => {
    const trick = [
      { seat: 'north', card: { suit: 'clubs', rank: 'A' } },
      { seat: 'east', card: { suit: 'spades', rank: '5' } },
      { seat: 'south', card: { suit: 'spades', rank: 'K' } },
      { seat: 'west', card: { suit: 'spades', rank: '2' } },
    ]
    assert.equal(determineTrickWinner(trick), 'south')
  })

  it('off-suit cards (not spades, not led suit) never win', { timeout: 2000 }, () => {
    const trick = [
      { seat: 'north', card: { suit: 'clubs', rank: '2' } },
      { seat: 'east', card: { suit: 'hearts', rank: 'A' } }, // off-suit, irrelevant
      { seat: 'south', card: { suit: 'diamonds', rank: 'A' } }, // off-suit, irrelevant
      { seat: 'west', card: { suit: 'clubs', rank: '3' } },
    ]
    assert.equal(determineTrickWinner(trick), 'west')
  })

  it('first spade played wins if it is the only spade', { timeout: 2000 }, () => {
    const trick = [
      { seat: 'north', card: { suit: 'hearts', rank: 'A' } },
      { seat: 'east', card: { suit: 'spades', rank: '2' } },
      { seat: 'south', card: { suit: 'hearts', rank: 'K' } },
      { seat: 'west', card: { suit: 'hearts', rank: 'Q' } },
    ]
    assert.equal(determineTrickWinner(trick), 'east')
  })
})

describe('isCardLegal', { timeout: 2000 }, () => {
  it('returns false if card not in hand', { timeout: 2000 }, () => {
    const hand = [{ suit: 'clubs', rank: 'A' }]
    assert.ok(
      !isCardLegal({ suit: 'spades', rank: 'K' }, hand, [], false, false),
    )
  })

  it('returns true if card is a legal play', { timeout: 2000 }, () => {
    const hand = [{ suit: 'clubs', rank: 'A' }]
    const trick = [{ seat: 'north', card: { suit: 'clubs', rank: '2' } }]
    assert.ok(isCardLegal({ suit: 'clubs', rank: 'A' }, hand, trick, false, false))
  })

  it('returns false if play violates suit-following rule', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'clubs', rank: 'A' },
      { suit: 'spades', rank: 'K' },
    ]
    const trick = [{ seat: 'north', card: { suit: 'clubs', rank: '2' } }]
    // Must follow clubs, playing spades is illegal
    assert.ok(!isCardLegal({ suit: 'spades', rank: 'K' }, hand, trick, false, false))
  })

  it('returns false if leading spades on first trick when non-spades available', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'clubs', rank: 'A' },
      { suit: 'spades', rank: 'K' },
    ]
    assert.ok(!isCardLegal({ suit: 'spades', rank: 'K' }, hand, [], false, true))
  })
})
