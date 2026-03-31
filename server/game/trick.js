import { rankValue, cardEquals } from './deck.js'

/**
 * Return the subset of cards in hand that the player may legally play.
 *
 * @param {Card[]} hand - The player's current hand
 * @param {Array<{seat: string, card: Card}>} currentTrick - Cards already played this trick
 * @param {boolean} spadesbroken - Whether spades have been broken this hand
 * @param {boolean} isFirstTrick - Whether this is the very first trick of the hand
 * @returns {Card[]}
 */
export function getLegalPlays(hand, currentTrick, spadesbroken, isFirstTrick) {
  const isLeading = currentTrick.length === 0

  if (isLeading) {
    if (isFirstTrick) {
      // Cannot lead spades on the first trick of a hand
      const nonSpades = hand.filter((c) => c.suit !== 'spades')
      return nonSpades.length > 0 ? nonSpades : hand
    }
    if (!spadesbroken) {
      // Cannot lead spades until they are broken
      const nonSpades = hand.filter((c) => c.suit !== 'spades')
      return nonSpades.length > 0 ? nonSpades : hand
    }
    // Spades are broken (or not leading) — any card is legal
    return hand
  }

  // Following a trick — must follow the led suit if possible
  const ledSuit = currentTrick[0].card.suit
  const canFollow = hand.filter((c) => c.suit === ledSuit)
  if (canFollow.length > 0) {
    return canFollow
  }

  // Cannot follow suit — on the first trick, may not play spades if alternatives exist
  if (isFirstTrick) {
    const nonSpades = hand.filter((c) => c.suit !== 'spades')
    if (nonSpades.length > 0) return nonSpades
  }

  // No suit-follow requirement and not restricted — any card is legal
  return hand
}

/**
 * Determine which seat wins a completed 4-card trick.
 *
 * @param {Array<{seat: string, card: Card}>} trick - Exactly 4 plays in order
 * @returns {string} The winning seat
 */
export function determineTrickWinner(trick) {
  const ledSuit = trick[0].card.suit
  let winner = trick[0]
  for (let i = 1; i < trick.length; i++) {
    if (beats(trick[i].card, winner.card, ledSuit)) {
      winner = trick[i]
    }
  }
  return winner.seat
}

/**
 * Return true if card `a` beats card `b` given the led suit.
 * Spades trump all other suits; within the same suit, higher rank wins.
 */
function beats(a, b, ledSuit) {
  if (a.suit === 'spades' && b.suit !== 'spades') return true
  if (b.suit === 'spades' && a.suit !== 'spades') return false
  // Both spades or both non-spades
  if (a.suit === b.suit) return rankValue(a.rank) > rankValue(b.rank)
  // Different non-spade suits: only the led suit card can win
  if (a.suit === ledSuit) return true
  // b is led suit (or neither is led suit, in which case b was leading)
  return false
}

/**
 * Check whether playing `card` is legal given the current game state.
 *
 * @param {Card} card
 * @param {Card[]} hand
 * @param {Array<{seat: string, card: Card}>} currentTrick
 * @param {boolean} spadesbroken
 * @param {boolean} isFirstTrick
 * @returns {boolean}
 */
export function isCardLegal(card, hand, currentTrick, spadesbroken, isFirstTrick) {
  const inHand = hand.some((c) => cardEquals(c, card))
  if (!inHand) return false
  const legal = getLegalPlays(hand, currentTrick, spadesbroken, isFirstTrick)
  return legal.some((c) => cardEquals(c, card))
}
