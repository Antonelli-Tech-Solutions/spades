const SUIT_SYMBOL = { spades: '\u2660', hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663' }
const RED_SUIT = new Set(['hearts', 'diamonds'])

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
  const red = RED_SUIT.has(card.suit) ? ' card-red' : ''
  const cls = extraCls ? ` ${extraCls}` : ''
  return `<span class="card${red}${cls}" data-suit="${esc(card.suit)}" data-rank="${esc(card.rank)}">${esc(card.rank)}${s}</span>`
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
      const red = RED_SUIT.has(suit) ? ' suit-red' : ''
      const extra = extraClsFn
      const cardsHtml = cards
        .map((card) => {
          const cls = extra(card)
          return cardHtml(card, `card-compact${cls ? ' ' + cls : ''}`)
        })
        .join('')
      return `<div class="diagram-row"><span class="diagram-suit${red}">${s}</span>${cardsHtml}</div>`
    })
    .join('')
}
