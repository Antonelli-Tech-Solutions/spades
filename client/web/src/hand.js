const SUIT_SYMBOL = { spades: '\u2660', hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663' }
const SUIT_CLASS = { spades: 'card-spades', hearts: 'card-hearts', diamonds: 'card-diamonds', clubs: 'card-clubs' }
const TRICK_CLASS = { spades: 'trick-spades', hearts: 'trick-hearts', diamonds: 'trick-diamonds', clubs: 'trick-clubs' }
const DIAG_CLASS  = { spades: 'suit-spades', hearts: 'suit-hearts', diamonds: 'suit-diamonds', clubs: 'suit-clubs' }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render a single card as an HTML `<span>` element.
 *
 * @param {{ suit: string, rank: string }} card
 * @param {string} [extraCls] - additional CSS class(es) to append
 * @returns {string} HTML string
 */
export function cardHtml(card, extraCls) {
  const s = SUIT_SYMBOL[card.suit]
  const suitCls = SUIT_CLASS[card.suit] ? ` ${SUIT_CLASS[card.suit]}` : ''
  const cls = extraCls ? ` ${extraCls}` : ''
  return `<span class="card${suitCls}${cls}" data-suit="${esc(card.suit)}" data-rank="${esc(card.rank)}">${esc(card.rank)}${s}</span>`
}

/**
 * Render a hand of cards in Spread (fan) mode — each card displayed side-by-side.
 *
 * @param {Array<{ suit: string, rank: string }>} hand
 * @param {function({ suit: string, rank: string }): string} extraClsFn - returns extra CSS classes for a given card
 * @returns {string} HTML string
 */
export function handSpreadHtml(hand, extraClsFn) {
  return hand.map((card) => cardHtml(card, extraClsFn(card))).join('')
}

/**
 * Render the completed last trick as a modal overlay.
 *
 * Shows all 4 cards in the same positional layout as the active trick area,
 * along with a label identifying the winner. Intended to be injected into the
 * page and controlled via `last-trick-overlay` and `last-trick-close` element IDs.
 *
 * @param {{ winner: string, plays: Array<{ seat: string, card: { suit: string, rank: string } }> }} lastTrick
 * @param {{ me: string, right: string, across: string, left: string }} rel - seat positions from current player's perspective
 * @returns {string} HTML string
 */
export function lastTrickHtml(lastTrick, rel) {
  const bySeats = {}
  for (const { seat, card } of lastTrick.plays) bySeats[seat] = card

  function slot(seat) {
    const card = bySeats[seat]
    if (!card) return '<div class="trick-slot"></div>'
    const s = SUIT_SYMBOL[card.suit]
    const suitCls = TRICK_CLASS[card.suit] ? ` ${TRICK_CLASS[card.suit]}` : ''
    return `<div class="trick-slot"><div class="trick-card${suitCls}">${esc(card.rank)}${s}</div></div>`
  }

  const winnerLabel = lastTrick.winner === rel.me
    ? 'You'
    : esc(lastTrick.winner.charAt(0).toUpperCase() + lastTrick.winner.slice(1))

  return `
    <div class="last-trick-overlay" id="last-trick-overlay">
      <div class="last-trick-modal">
        <div class="last-trick-title">Last Trick</div>
        <div class="last-trick-winner-label">Won by ${winnerLabel}</div>
        <div class="trick-area">
          <div class="trick-row">${slot(rel.across)}</div>
          <div class="trick-row trick-middle">
            ${slot(rel.left)}
            <div class="trick-center"></div>
            ${slot(rel.right)}
          </div>
          <div class="trick-row">${slot(rel.me)}</div>
        </div>
        <button class="last-trick-close" id="last-trick-close">Close</button>
      </div>
    </div>`
}

/**
 * Render a hand of cards in Hand Diagram mode — cards grouped by suit, one suit per row,
 * with the suit symbol followed by the card ranks. Suits with no cards are omitted.
 *
 * Example output shape: ♠J32  ♥A32  ♦K32  ♣AQ32
 *
 * @param {Array<{ suit: string, rank: string }>} hand
 * @param {function({ suit: string, rank: string }): string} extraClsFn - returns extra CSS classes for a given card
 * @returns {string} HTML string
 */
export function handDiagramHtml(hand, extraClsFn) {
  const bySuit = { spades: [], hearts: [], diamonds: [], clubs: [] }
  for (const c of hand) bySuit[c.suit].push(c)

  return Object.entries(bySuit)
    .filter(([, cards]) => cards.length > 0)
    .map(([suit, cards]) => {
      const s = SUIT_SYMBOL[suit]
      const diagCls = DIAG_CLASS[suit] ? ` ${DIAG_CLASS[suit]}` : ''
      const extra = extraClsFn
      const cardsHtml = cards
        .map((card) => {
          const cls = extra(card)
          return cardHtml(card, `card-compact${cls ? ' ' + cls : ''}`)
        })
        .join('')
      return `<div class="diagram-row"><span class="diagram-suit${diagCls}">${s}</span>${cardsHtml}</div>`
    })
    .join('')
}
