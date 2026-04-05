const SUIT_SYMBOL = { spades: '\u2660', hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663' }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Hold durations in milliseconds by animation speed setting.
 * Hardcoded to `normal` (1500 ms) until the animation speed setting ships in Slice 5.
 */
export const HOLD_DURATIONS = { slow: 2500, normal: 1500, fast: 800 }

/**
 * Returns true when nextState has transitioned to a new (non-final) hand.
 * In this case completedTricks was reset to [] for the new hand, meaning the
 * caller should keep prevState visible during the trick-hold window instead of
 * immediately rendering the new hand's bidding screen.
 *
 * Returns false for game_over because completedTricks is NOT reset there —
 * the final state is safe to render during the hold.
 *
 * @param {object|null} prevState
 * @param {object} nextState
 * @returns {boolean}
 */
export function isHandTransition(prevState, nextState) {
  if (!prevState || !nextState) return false
  if (nextState.phase === 'game_over') return false
  const prevHistoryLen = Array.isArray(prevState.handHistory) ? prevState.handHistory.length : 0
  const nextHistoryLen = Array.isArray(nextState.handHistory) ? nextState.handHistory.length : 0
  return nextHistoryLen > prevHistoryLen
}

/**
 * Compare two successive game states and return the trick that was just
 * completed, or null if no new trick completed between the two states.
 *
 * A trick is considered newly completed when nextState.completedTricks is
 * longer than prevState.completedTricks.
 *
 * @param {object|null} prevState
 * @param {object} nextState
 * @returns {{ winner: string, plays: Array<{ seat: string, card: object }> } | null}
 */
export function detectCompletedTrick(prevState, nextState) {
  if (!prevState || !nextState) return null
  if (!Array.isArray(nextState.completedTricks)) return null
  const prevLen = Array.isArray(prevState.completedTricks) ? prevState.completedTricks.length : 0
  if (nextState.completedTricks.length > prevLen) {
    return nextState.completedTricks[nextState.completedTricks.length - 1]
  }
  // The 13th trick completes a hand and completedTricks is reset for the new hand.
  // Detect this by checking whether handHistory grew, then use lastTrick from the new entry.
  const prevHistoryLen = Array.isArray(prevState.handHistory) ? prevState.handHistory.length : 0
  const nextHistoryLen = Array.isArray(nextState.handHistory) ? nextState.handHistory.length : 0
  if (nextHistoryLen > prevHistoryLen) {
    const lastEntry = nextState.handHistory[nextState.handHistory.length - 1]
    if (lastEntry?.lastTrick) return lastEntry.lastTrick
  }
  return null
}

/**
 * Render a just-completed trick inline in the trick area during the hold window.
 * Displays all four cards in the positional layout (same as the active trick area)
 * with a winner banner above the cards.
 *
 * @param {{ winner: string, plays: Array<{ seat: string, card: object }> }} trick
 * @param {{ me: string, right: string, across: string, left: string }} rel - seat positions from current player's perspective
 * @returns {string} HTML string
 */
export function trickHoldHtml(trick, rel) {
  const bySeats = {}
  for (const { seat, card } of trick.plays) bySeats[seat] = card

  function slot(seat) {
    const card = bySeats[seat]
    if (!card) return '<div class="trick-slot"></div>'
    const s = SUIT_SYMBOL[card.suit]
    const colorCls = card.suit ? ` trick-${card.suit}` : ''
    return `<div class="trick-slot"><div class="trick-card${colorCls}">${esc(card.rank)}${s}</div></div>`
  }

  const winnerLabel = trick.winner === rel.me
    ? 'You'
    : esc(trick.winner.charAt(0).toUpperCase() + trick.winner.slice(1))

  return `
    <div class="trick-area trick-area--hold">
      <div class="trick-winner-banner">Won by ${winnerLabel}</div>
      <div class="trick-row">${slot(rel.across)}</div>
      <div class="trick-row trick-middle">
        ${slot(rel.left)}
        <div class="trick-center"></div>
        ${slot(rel.right)}
      </div>
      <div class="trick-row">${slot(rel.me)}</div>
    </div>`
}
