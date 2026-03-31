export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades']
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']

const SUIT_ORDER = Object.fromEntries(SUITS.map((s, i) => [s, i]))
const RANK_ORDER = Object.fromEntries(RANKS.map((r, i) => [r, i]))

/** Create an unshuffled 52-card deck. */
export function createDeck() {
  const deck = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank })
    }
  }
  return deck
}

/** Fisher-Yates shuffle — returns a new array, does not mutate the input. */
export function shuffle(deck) {
  const d = [...deck]
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[d[i], d[j]] = [d[j], d[i]]
  }
  return d
}

/**
 * Deal 52 cards into 4 hands of 13 in clockwise seat order: north, east, south, west.
 * @param {Array} deck - A shuffled 52-card deck
 * @returns {{ north: Card[], east: Card[], south: Card[], west: Card[] }}
 */
export function deal(deck) {
  const seats = ['north', 'east', 'south', 'west']
  const hands = { north: [], east: [], south: [], west: [] }
  for (let i = 0; i < 52; i++) {
    hands[seats[i % 4]].push(deck[i])
  }
  return hands
}

/**
 * Return the numeric sort value for a rank (higher = stronger).
 * @param {string} rank
 * @returns {number}
 */
export function rankValue(rank) {
  return RANK_ORDER[rank]
}

/**
 * Sort a hand by suit (clubs < diamonds < hearts < spades) then rank (2 < … < A).
 * Returns a new array — does not mutate the input.
 * @param {Card[]} hand
 * @returns {Card[]}
 */
export function sortHand(hand) {
  return [...hand].sort((a, b) => {
    if (SUIT_ORDER[a.suit] !== SUIT_ORDER[b.suit]) {
      return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit]
    }
    return RANK_ORDER[a.rank] - RANK_ORDER[b.rank]
  })
}

/**
 * Check whether two cards represent the same card.
 * @param {{ suit: string, rank: string }} a
 * @param {{ suit: string, rank: string }} b
 * @returns {boolean}
 */
export function cardEquals(a, b) {
  return a.suit === b.suit && a.rank === b.rank
}
