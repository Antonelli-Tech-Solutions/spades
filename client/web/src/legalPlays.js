/**
 * Pure game-rule helpers shared between client-side delta handling and
 * server-side logic.  Must have zero Node.js / server-only dependencies so
 * that it can be imported directly by the browser bundle.
 */

/**
 * Return the subset of cards in hand that the player may legally play.
 *
 * Mirrors server/game/trick.js:getLegalPlays — keep the two in sync if the
 * rules ever change.
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
    // Spades are broken — any card is legal to lead
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
