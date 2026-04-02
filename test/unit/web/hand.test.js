import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cardHtml, handSpreadHtml, handDiagramHtml, lastTrickHtml } from '../../../client/web/src/hand.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noExtra = () => ''

function parseSpans(html) {
  // Extract all <span> opening tag attribute strings
  const spans = []
  const re = /<span([^>]*)>/g
  let m
  while ((m = re.exec(html)) !== null) spans.push(m[1])
  return spans
}

function attr(spanAttrs, name) {
  const m = spanAttrs.match(new RegExp(`${name}="([^"]*)"`, ''))
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// cardHtml
// ---------------------------------------------------------------------------

describe('cardHtml', () => {
  it('renders rank and suit symbol inside a span', () => {
    const html = cardHtml({ suit: 'spades', rank: 'A' }, '')
    assert.ok(html.includes('A\u2660'), 'should contain rank + ♠')
    assert.ok(html.startsWith('<span'), 'should be a span element')
  })

  it('sets data-suit and data-rank attributes', () => {
    const html = cardHtml({ suit: 'hearts', rank: 'K' }, '')
    assert.ok(html.includes('data-suit="hearts"'))
    assert.ok(html.includes('data-rank="K"'))
  })

  it('adds card-red class for red suits', () => {
    const hearts = cardHtml({ suit: 'hearts', rank: '2' }, '')
    const diamonds = cardHtml({ suit: 'diamonds', rank: '2' }, '')
    assert.ok(hearts.includes('card-red'), 'hearts should be red')
    assert.ok(diamonds.includes('card-red'), 'diamonds should be red')
  })

  it('does not add card-red class for black suits', () => {
    const spades = cardHtml({ suit: 'spades', rank: '2' }, '')
    const clubs = cardHtml({ suit: 'clubs', rank: '2' }, '')
    assert.ok(!spades.includes('card-red'), 'spades should not be red')
    assert.ok(!clubs.includes('card-red'), 'clubs should not be red')
  })

  it('appends extra CSS class when provided', () => {
    const html = cardHtml({ suit: 'spades', rank: 'Q' }, 'card-play')
    assert.ok(html.includes('card-play'))
  })

  it('does not append extra whitespace when extraCls is empty string', () => {
    const html = cardHtml({ suit: 'spades', rank: 'Q' }, '')
    // class attribute should not end with a trailing space before the closing quote
    assert.ok(!html.match(/class="[^"]*\s"/), 'should have no trailing space in class')
  })

  it('escapes HTML special characters in rank', () => {
    const html = cardHtml({ suit: 'spades', rank: '<script>' }, '')
    assert.ok(!html.includes('<script>'), 'raw HTML should be escaped')
    assert.ok(html.includes('&lt;script&gt;'))
  })

  it('uses the correct symbol for each suit', () => {
    assert.ok(cardHtml({ suit: 'spades', rank: 'A' }, '').includes('\u2660'))
    assert.ok(cardHtml({ suit: 'hearts', rank: 'A' }, '').includes('\u2665'))
    assert.ok(cardHtml({ suit: 'diamonds', rank: 'A' }, '').includes('\u2666'))
    assert.ok(cardHtml({ suit: 'clubs', rank: 'A' }, '').includes('\u2663'))
  })
})

// ---------------------------------------------------------------------------
// handSpreadHtml — Spread (fan) mode
// ---------------------------------------------------------------------------

describe('handSpreadHtml', () => {
  it('returns empty string for an empty hand', () => {
    assert.equal(handSpreadHtml([], noExtra), '')
  })

  it('renders one span per card', () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: 'K' },
      { suit: 'diamonds', rank: 'Q' },
    ]
    const html = handSpreadHtml(hand, noExtra)
    const spans = parseSpans(html)
    assert.equal(spans.length, 3)
  })

  it('renders cards in hand order', () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'clubs', rank: '2' },
    ]
    const html = handSpreadHtml(hand, noExtra)
    const sA = html.indexOf('data-rank="A"')
    const s2 = html.indexOf('data-rank="2"')
    assert.ok(sA < s2, 'Ace of spades should appear before 2 of clubs')
  })

  it('forwards extra CSS class returned by extraClsFn', () => {
    const hand = [{ suit: 'spades', rank: 'A' }]
    const html = handSpreadHtml(hand, () => 'card-play')
    assert.ok(html.includes('card-play'))
  })

  it('does not add extra class when extraClsFn returns empty string', () => {
    const hand = [{ suit: 'spades', rank: 'A' }]
    const html = handSpreadHtml(hand, noExtra)
    assert.ok(!html.includes('card-play'))
  })

  it('marks red-suit cards with card-red', () => {
    const hand = [
      { suit: 'hearts', rank: '5' },
      { suit: 'spades', rank: '5' },
    ]
    const html = handSpreadHtml(hand, noExtra)
    // Only the hearts card should get card-red
    const heartsIdx = html.indexOf('data-suit="hearts"')
    const spadesIdx = html.indexOf('data-suit="spades"')
    // Grab the class attributes from each span block
    const heartsSpan = html.slice(html.lastIndexOf('<span', heartsIdx), heartsIdx)
    const spadesSpan = html.slice(html.lastIndexOf('<span', spadesIdx), spadesIdx)
    assert.ok(heartsSpan.includes('card-red'))
    assert.ok(!spadesSpan.includes('card-red'))
  })
})

// ---------------------------------------------------------------------------
// handDiagramHtml — Hand Diagram mode
// ---------------------------------------------------------------------------

describe('handDiagramHtml', () => {
  it('returns empty string for an empty hand', () => {
    assert.equal(handDiagramHtml([], noExtra), '')
  })

  it('creates one diagram-row div per suit present', () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: 'K' },
      { suit: 'spades', rank: '2' },
    ]
    const html = handDiagramHtml(hand, noExtra)
    const rows = (html.match(/class="diagram-row"/g) || []).length
    assert.equal(rows, 2, 'only suits with cards should produce a row')
  })

  it('omits suits with no cards', () => {
    const hand = [{ suit: 'spades', rank: 'A' }]
    const html = handDiagramHtml(hand, noExtra)
    assert.ok(!html.includes('\u2665'), 'hearts symbol should not appear')
    assert.ok(!html.includes('\u2666'), 'diamonds symbol should not appear')
    assert.ok(!html.includes('\u2663'), 'clubs symbol should not appear')
  })

  it('shows the suit symbol at the start of each row', () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: 'K' },
    ]
    const html = handDiagramHtml(hand, noExtra)
    assert.ok(html.includes('class="diagram-suit"'), 'spades row should have diagram-suit class')
    assert.ok(html.includes('class="diagram-suit suit-red"'), 'hearts row should have suit-red class')
  })

  it('renders all cards for a suit in a single row', () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'spades', rank: 'K' },
      { suit: 'spades', rank: '2' },
    ]
    const html = handDiagramHtml(hand, noExtra)
    // All three should appear and there should be exactly one row
    assert.equal((html.match(/class="diagram-row"/g) || []).length, 1)
    assert.ok(html.includes('data-rank="A"'))
    assert.ok(html.includes('data-rank="K"'))
    assert.ok(html.includes('data-rank="2"'))
  })

  it('adds card-compact class to every card in diagram mode', () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: 'K' },
    ]
    const html = handDiagramHtml(hand, noExtra)
    const cardSpans = (html.match(/card-compact/g) || []).length
    assert.equal(cardSpans, 2)
  })

  it('forwards extra CSS class alongside card-compact', () => {
    const hand = [{ suit: 'spades', rank: 'A' }]
    const html = handDiagramHtml(hand, () => 'card-sel')
    assert.ok(html.includes('card-compact card-sel'))
  })

  it('suit order is spades, hearts, diamonds, clubs', () => {
    const hand = [
      { suit: 'clubs', rank: '3' },
      { suit: 'diamonds', rank: '4' },
      { suit: 'hearts', rank: '5' },
      { suit: 'spades', rank: '6' },
    ]
    const html = handDiagramHtml(hand, noExtra)
    const spIdx = html.indexOf('\u2660')
    const hIdx = html.indexOf('\u2665')
    const dIdx = html.indexOf('\u2666')
    const cIdx = html.indexOf('\u2663')
    assert.ok(spIdx < hIdx, 'spades before hearts')
    assert.ok(hIdx < dIdx, 'hearts before diamonds')
    assert.ok(dIdx < cIdx, 'diamonds before clubs')
  })
})

// ---------------------------------------------------------------------------
// lastTrickHtml
// ---------------------------------------------------------------------------

describe('lastTrickHtml', () => {
  const rel = { me: 'south', right: 'west', across: 'north', left: 'east' }

  const fullTrick = {
    winner: 'north',
    plays: [
      { seat: 'north', card: { suit: 'spades', rank: 'A' } },
      { seat: 'east',  card: { suit: 'clubs',  rank: '2' } },
      { seat: 'south', card: { suit: 'hearts', rank: 'K' } },
      { seat: 'west',  card: { suit: 'diamonds', rank: 'Q' } },
    ],
  }

  it('renders all 4 cards', () => {
    const html = lastTrickHtml(fullTrick, rel)
    assert.ok(html.includes('A\u2660'), 'should contain A♠')
    assert.ok(html.includes('2\u2663'), 'should contain 2♣')
    assert.ok(html.includes('K\u2665'), 'should contain K♥')
    assert.ok(html.includes('Q\u2666'), 'should contain Q♦')
  })

  it('shows "Won by You" when current player won', () => {
    const trick = { winner: 'south', plays: fullTrick.plays }
    const html = lastTrickHtml(trick, rel)
    assert.ok(html.includes('Won by You'), 'should say "Won by You"')
  })

  it('shows capitalized seat name when an opponent won', () => {
    const html = lastTrickHtml(fullTrick, rel)
    assert.ok(html.includes('Won by North'), 'should say "Won by North"')
  })

  it('applies trick-red class to red-suit cards', () => {
    const html = lastTrickHtml(fullTrick, rel)
    // hearts (K) and diamonds (Q) should have trick-red
    const redCount = (html.match(/trick-red/g) || []).length
    assert.equal(redCount, 2, 'exactly 2 red-suit cards should have trick-red')
  })

  it('does not apply trick-red to black-suit cards', () => {
    const blackOnly = {
      winner: 'north',
      plays: [
        { seat: 'north', card: { suit: 'spades',  rank: 'A' } },
        { seat: 'east',  card: { suit: 'clubs',   rank: '2' } },
        { seat: 'south', card: { suit: 'spades',  rank: '3' } },
        { seat: 'west',  card: { suit: 'clubs',   rank: '4' } },
      ],
    }
    const html = lastTrickHtml(blackOnly, rel)
    assert.equal((html.match(/trick-red/g) || []).length, 0)
  })

  it('escapes HTML special characters in card rank', () => {
    const trick = {
      winner: 'north',
      plays: [
        { seat: 'north', card: { suit: 'spades', rank: '<b>' } },
        { seat: 'east',  card: { suit: 'clubs',  rank: '2' } },
        { seat: 'south', card: { suit: 'hearts', rank: '3' } },
        { seat: 'west',  card: { suit: 'diamonds', rank: '4' } },
      ],
    }
    const html = lastTrickHtml(trick, rel)
    assert.ok(!html.includes('<b>'), 'raw HTML should be escaped')
    assert.ok(html.includes('&lt;b&gt;'))
  })

  it('renders the overlay and modal wrapper elements', () => {
    const html = lastTrickHtml(fullTrick, rel)
    assert.ok(html.includes('last-trick-overlay'), 'should include overlay element')
    assert.ok(html.includes('last-trick-modal'), 'should include modal element')
    assert.ok(html.includes('last-trick-close'), 'should include close button')
  })
})
