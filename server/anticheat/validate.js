import { isCardLegal } from '../game/trick.js'
import { cardEquals } from '../game/deck.js'

/**
 * Validate that a player is allowed to play the given card.
 *
 * Checks (in order):
 * 1. Game must be in 'playing' phase.
 * 2. It must be the player's turn.
 * 3. The card must exist in the player's hand.
 * 4. The card must be a legal play under current game rules.
 *
 * Throws a structured error on any violation.
 *
 * @param {object} gameState - Full server game state
 * @param {string} seat - Seat of the player attempting to play
 * @param {{ suit: string, rank: string }} card - The card being played
 */
export function validateCardPlay(gameState, seat, card) {
  if (gameState.phase !== 'playing') {
    throw Object.assign(new Error('Game is not in playing phase'), { code: 'INVALID_ACTION' })
  }
  if (gameState.currentPlayerSeat !== seat) {
    throw Object.assign(new Error('It is not your turn'), { code: 'NOT_YOUR_TURN' })
  }

  const hand = gameState.hands[seat]
  if (!hand || !hand.some((c) => cardEquals(c, card))) {
    throw Object.assign(new Error('Card is not in your hand'), { code: 'CARD_NOT_IN_HAND' })
  }

  if (!isCardLegal(card, hand, gameState.currentTrick, gameState.spadesbroken, gameState.isFirstTrick)) {
    throw Object.assign(new Error('That card is not a legal play'), { code: 'ILLEGAL_PLAY' })
  }
}

/**
 * Validate that a player is allowed to place a bid.
 *
 * @param {object} gameState
 * @param {string} seat
 */
export function validateBidTurn(gameState, seat) {
  if (gameState.phase !== 'bidding') {
    throw Object.assign(new Error('Game is not in bidding phase'), { code: 'INVALID_ACTION' })
  }
  if (gameState.currentBidderSeat !== seat) {
    throw Object.assign(new Error('It is not your turn to bid'), { code: 'NOT_YOUR_TURN' })
  }
}

/**
 * Derive the seat for a player at a given table from the table's seats map.
 *
 * @param {{ north: string|null, east: string|null, south: string|null, west: string|null }} seats
 * @param {string} playerId
 * @returns {string|null} Seat name or null if player is not seated
 */
export function getSeatForPlayer(seats, playerId) {
  return Object.entries(seats).find(([, pid]) => pid === playerId)?.[0] ?? null
}
