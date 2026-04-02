import { getLegalPlays } from './trick.js'

/**
 * Return true if a player ID belongs to a bot seat.
 * Bot IDs follow the pattern "bot:<seat>".
 *
 * @param {*} playerId
 * @returns {boolean}
 */
export function isBot(playerId) {
  return typeof playerId === 'string' && playerId.startsWith('bot:')
}

/**
 * Return the canonical bot player ID for a given seat.
 * @param {string} seat
 * @returns {string}
 */
export function getBotPlayerId(seat) {
  return `bot:${seat}`
}

/**
 * Compute the bot's bid: count the number of spades in its hand.
 * This is a legal bid value (0–13) under all conditions.
 *
 * @param {Array<{suit: string, rank: string}>} hand
 * @returns {number}
 */
export function botBid(hand) {
  return hand.filter((c) => c.suit === 'spades').length
}

/**
 * Choose a card for the bot to play.
 * Picks uniformly at random from the set of legal plays.
 *
 * @param {Array<{suit: string, rank: string}>} hand
 * @param {Array<{seat: string, card: {suit: string, rank: string}}>} currentTrick
 * @param {boolean} spadesbroken
 * @param {boolean} isFirstTrick
 * @returns {{suit: string, rank: string}}
 */
export function botPlay(hand, currentTrick, spadesbroken, isFirstTrick) {
  const legal = getLegalPlays(hand, currentTrick, spadesbroken, isFirstTrick)
  return legal[Math.floor(Math.random() * legal.length)]
}
