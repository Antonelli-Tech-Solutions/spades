import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDeck,
  shuffle,
  deal,
  sortHand,
  rankValue,
  cardEquals,
  SUITS,
  RANKS,
} from '../../../server/game/deck.js'

describe('createDeck', () => {
  it('returns 52 cards', () => {
    const deck = createDeck()
    assert.equal(deck.length, 52)
  })

  it('has 13 cards per suit', () => {
    const deck = createDeck()
    for (const suit of SUITS) {
      const count = deck.filter((c) => c.suit === suit).length
      assert.equal(count, 13, `expected 13 ${suit} cards`)
    }
  })

  it('has 4 of each rank', () => {
    const deck = createDeck()
    for (const rank of RANKS) {
      const count = deck.filter((c) => c.rank === rank).length
      assert.equal(count, 4, `expected 4 cards of rank ${rank}`)
    }
  })

  it('has no duplicate cards', () => {
    const deck = createDeck()
    const unique = new Set(deck.map((c) => `${c.suit}:${c.rank}`))
    assert.equal(unique.size, 52)
  })
})

describe('shuffle', () => {
  it('returns a deck with 52 cards', () => {
    const deck = createDeck()
    const shuffled = shuffle(deck)
    assert.equal(shuffled.length, 52)
  })

  it('does not mutate the original deck', () => {
    const deck = createDeck()
    const original = deck.map((c) => ({ ...c }))
    shuffle(deck)
    assert.deepEqual(deck, original)
  })

  it('contains the same cards as the original', () => {
    const deck = createDeck()
    const shuffled = shuffle(deck)
    const toKey = (c) => `${c.suit}:${c.rank}`
    const orig = new Set(deck.map(toKey))
    const shuf = new Set(shuffled.map(toKey))
    assert.equal(orig.size, shuf.size)
    for (const k of orig) assert.ok(shuf.has(k), `missing card ${k}`)
  })
})

describe('deal', () => {
  it('returns 4 hands of 13 cards each', () => {
    const deck = shuffle(createDeck())
    const hands = deal(deck)
    for (const seat of ['north', 'east', 'south', 'west']) {
      assert.equal(hands[seat].length, 13, `${seat} should have 13 cards`)
    }
  })

  it('distributes all 52 cards without duplication', () => {
    const deck = shuffle(createDeck())
    const hands = deal(deck)
    const allCards = [
      ...hands.north,
      ...hands.east,
      ...hands.south,
      ...hands.west,
    ]
    assert.equal(allCards.length, 52)
    const unique = new Set(allCards.map((c) => `${c.suit}:${c.rank}`))
    assert.equal(unique.size, 52)
  })
})

describe('sortHand', () => {
  it('sorts clubs before diamonds before hearts before spades', () => {
    const hand = [
      { suit: 'spades', rank: '2' },
      { suit: 'hearts', rank: '3' },
      { suit: 'clubs', rank: '4' },
      { suit: 'diamonds', rank: '5' },
    ]
    const sorted = sortHand(hand)
    assert.equal(sorted[0].suit, 'clubs')
    assert.equal(sorted[1].suit, 'diamonds')
    assert.equal(sorted[2].suit, 'hearts')
    assert.equal(sorted[3].suit, 'spades')
  })

  it('sorts by rank ascending within the same suit', () => {
    const hand = [
      { suit: 'clubs', rank: 'A' },
      { suit: 'clubs', rank: '2' },
      { suit: 'clubs', rank: 'K' },
      { suit: 'clubs', rank: '10' },
    ]
    const sorted = sortHand(hand)
    assert.deepEqual(
      sorted.map((c) => c.rank),
      ['2', '10', 'K', 'A'],
    )
  })

  it('does not mutate the original hand', () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'clubs', rank: '2' },
    ]
    const original = hand.map((c) => ({ ...c }))
    sortHand(hand)
    assert.deepEqual(hand, original)
  })
})

describe('rankValue', () => {
  it('returns a higher value for A than K', () => {
    assert.ok(rankValue('A') > rankValue('K'))
  })

  it('returns a higher value for K than Q', () => {
    assert.ok(rankValue('K') > rankValue('Q'))
  })

  it('returns a higher value for 10 than 9', () => {
    assert.ok(rankValue('10') > rankValue('9'))
  })

  it('returns a higher value for J than 10', () => {
    assert.ok(rankValue('J') > rankValue('10'))
  })

  it('returns the lowest value for 2', () => {
    for (const r of RANKS.filter((r) => r !== '2')) {
      assert.ok(rankValue('2') < rankValue(r), `2 should be less than ${r}`)
    }
  })
})

describe('cardEquals', () => {
  it('returns true for the same card', () => {
    assert.ok(cardEquals({ suit: 'spades', rank: 'A' }, { suit: 'spades', rank: 'A' }))
  })

  it('returns false when suit differs', () => {
    assert.ok(!cardEquals({ suit: 'spades', rank: 'A' }, { suit: 'hearts', rank: 'A' }))
  })

  it('returns false when rank differs', () => {
    assert.ok(!cardEquals({ suit: 'spades', rank: 'A' }, { suit: 'spades', rank: 'K' }))
  })
})
