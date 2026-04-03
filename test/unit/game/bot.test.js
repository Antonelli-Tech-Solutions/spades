import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isBot, getBotPlayerId, botBid, botPlay, botBlindNilExchange } from '../../../server/game/bot.js'

describe('isBot', () => {
  it('returns true for bot player IDs', () => {
    assert.equal(isBot('bot:north'), true)
    assert.equal(isBot('bot:south'), true)
    assert.equal(isBot('bot:east'), true)
    assert.equal(isBot('bot:west'), true)
  })

  it('returns false for human player IDs', () => {
    assert.equal(isBot('some-uuid-player-id'), false)
    assert.equal(isBot(null), false)
    assert.equal(isBot(undefined), false)
    assert.equal(isBot(''), false)
  })
})

describe('getBotPlayerId', () => {
  it('returns bot:<seat> for each seat', () => {
    assert.equal(getBotPlayerId('north'), 'bot:north')
    assert.equal(getBotPlayerId('south'), 'bot:south')
    assert.equal(getBotPlayerId('east'), 'bot:east')
    assert.equal(getBotPlayerId('west'), 'bot:west')
  })
})

describe('botBid', () => {
  it('counts spades in hand', () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'spades', rank: 'K' },
      { suit: 'hearts', rank: 'Q' },
      { suit: 'clubs', rank: '7' },
    ]
    assert.equal(botBid(hand), 2)
  })

  it('returns 0 when no spades in hand', () => {
    const hand = [
      { suit: 'hearts', rank: 'A' },
      { suit: 'clubs', rank: 'K' },
      { suit: 'diamonds', rank: 'Q' },
    ]
    assert.equal(botBid(hand), 0)
  })

  it('returns 13 when hand is all spades', () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'spades', rank: 'K' },
      { suit: 'spades', rank: 'Q' },
      { suit: 'spades', rank: 'J' },
      { suit: 'spades', rank: '10' },
      { suit: 'spades', rank: '9' },
      { suit: 'spades', rank: '8' },
      { suit: 'spades', rank: '7' },
      { suit: 'spades', rank: '6' },
      { suit: 'spades', rank: '5' },
      { suit: 'spades', rank: '4' },
      { suit: 'spades', rank: '3' },
      { suit: 'spades', rank: '2' },
    ]
    assert.equal(botBid(hand), 13)
  })
})

describe('botPlay', () => {
  it('returns a card that is in the hand', () => {
    const hand = [
      { suit: 'hearts', rank: 'A' },
      { suit: 'clubs', rank: 'K' },
      { suit: 'spades', rank: 'Q' },
    ]
    const card = botPlay(hand, [], true, false)
    assert.ok(hand.some((c) => c.suit === card.suit && c.rank === card.rank))
  })

  it('does not lead spades on the first trick when alternatives exist', () => {
    const hand = [
      { suit: 'hearts', rank: 'A' },
      { suit: 'spades', rank: 'K' },
    ]
    const card = botPlay(hand, [], false, true)
    assert.equal(card.suit, 'hearts')
  })

  it('follows suit if possible', () => {
    const hand = [
      { suit: 'hearts', rank: 'A' },
      { suit: 'spades', rank: 'K' },
    ]
    const currentTrick = [{ seat: 'north', card: { suit: 'hearts', rank: '7' } }]
    const card = botPlay(hand, currentTrick, false, false)
    assert.equal(card.suit, 'hearts')
  })

  it('can play any card when cannot follow suit', () => {
    const hand = [
      { suit: 'spades', rank: 'K' },
      { suit: 'clubs', rank: '5' },
    ]
    const currentTrick = [{ seat: 'north', card: { suit: 'hearts', rank: '7' } }]
    const card = botPlay(hand, currentTrick, false, false)
    assert.ok(hand.some((c) => c.suit === card.suit && c.rank === card.rank))
  })

  it('returns a card from a single-card hand', () => {
    const hand = [{ suit: 'clubs', rank: '2' }]
    const card = botPlay(hand, [], false, false)
    assert.equal(card.suit, 'clubs')
    assert.equal(card.rank, '2')
  })
})

describe('botBlindNilExchange', () => {
  const hand = [
    { suit: 'spades', rank: 'A' },
    { suit: 'spades', rank: 'K' },
    { suit: 'hearts', rank: 'Q' },
    { suit: 'clubs', rank: '7' },
    { suit: 'diamonds', rank: '3' },
  ]

  it('returns exactly 2 cards', () => {
    const cards = botBlindNilExchange(hand)
    assert.equal(cards.length, 2)
  })

  it('returns cards that are in the hand', () => {
    const cards = botBlindNilExchange(hand)
    for (const card of cards) {
      assert.ok(hand.some((c) => c.suit === card.suit && c.rank === card.rank))
    }
  })

  it('returns 2 distinct cards (no duplicate)', () => {
    const cards = botBlindNilExchange(hand)
    assert.notDeepEqual(cards[0], cards[1])
  })

  it('does not mutate the original hand', () => {
    const originalLength = hand.length
    botBlindNilExchange(hand)
    assert.equal(hand.length, originalLength)
  })
})
