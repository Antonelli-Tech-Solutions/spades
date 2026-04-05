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

describe('cardHtml', { timeout: 2000 }, () => {
  it('renders rank and suit symbol inside a span', { timeout: 2000 }, () => {
    const html = cardHtml({ suit: 'spades', rank: 'A' }, '')
    assert.ok(html.includes('A\u2660'), 'should contain rank + ♠')
    assert.ok(html.startsWith('<span'), 'should be a span element')
  })

  it('sets data-suit and data-rank attributes', { timeout: 2000 }, () => {
    const html = cardHtml({ suit: 'hearts', rank: 'K' }, '')
    assert.ok(html.includes('data-suit="hearts"'))
    assert.ok(html.includes('data-rank="K"'))
  })

  it('adds suit-specific color class for each suit', { timeout: 2000 }, () => {
    const hearts = cardHtml({ suit: 'hearts', rank: '2' }, '')
    const diamonds = cardHtml({ suit: 'diamonds', rank: '2' }, '')
    const spades = cardHtml({ suit: 'spades', rank: '2' }, '')
    const clubs = cardHtml({ suit: 'clubs', rank: '2' }, '')
    assert.ok(hearts.includes('card-hearts'), 'hearts should have card-hearts class')
    assert.ok(diamonds.includes('card-diamonds'), 'diamonds should have card-diamonds class')
    assert.ok(spades.includes('card-spades'), 'spades should have card-spades class')
    assert.ok(clubs.includes('card-clubs'), 'clubs should have card-clubs class')
  })

  it('does not mix up suit color classes', { timeout: 2000 }, () => {
    const spades = cardHtml({ suit: 'spades', rank: '2' }, '')
    const clubs = cardHtml({ suit: 'clubs', rank: '2' }, '')
    assert.ok(!spades.includes('card-hearts'), 'spades should not have card-hearts class')
    assert.ok(!clubs.includes('card-diamonds'), 'clubs should not have card-diamonds class')
  })

  it('appends extra CSS class when provided', { timeout: 2000 }, () => {
    const html = cardHtml({ suit: 'spades', rank: 'Q' }, 'card-play')
    assert.ok(html.includes('card-play'))
  })

  it('does not append extra whitespace when extraCls is empty string', { timeout: 2000 }, () => {
    const html = cardHtml({ suit: 'spades', rank: 'Q' }, '')
    // class attribute should not end with a trailing space before the closing quote
    assert.ok(!html.match(/class="[^"]*\s"/), 'should have no trailing space in class')
  })

  it('escapes HTML special characters in rank', { timeout: 2000 }, () => {
    const html = cardHtml({ suit: 'spades', rank: '<script>' }, '')
    assert.ok(!html.includes('<script>'), 'raw HTML should be escaped')
    assert.ok(html.includes('&lt;script&gt;'))
  })

  it('uses the correct symbol for each suit', { timeout: 2000 }, () => {
    assert.ok(cardHtml({ suit: 'spades', rank: 'A' }, '').includes('\u2660'))
    assert.ok(cardHtml({ suit: 'hearts', rank: 'A' }, '').includes('\u2665'))
    assert.ok(cardHtml({ suit: 'diamonds', rank: 'A' }, '').includes('\u2666'))
    assert.ok(cardHtml({ suit: 'clubs', rank: 'A' }, '').includes('\u2663'))
  })
})

// ---------------------------------------------------------------------------
// handSpreadHtml — Spread (fan) mode
// ---------------------------------------------------------------------------

describe('handSpreadHtml', { timeout: 2000 }, () => {
  it('returns empty string for an empty hand', { timeout: 2000 }, () => {
    assert.equal(handSpreadHtml([], noExtra), '')
  })

  it('renders one span per card', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: 'K' },
      { suit: 'diamonds', rank: 'Q' },
    ]
    const html = handSpreadHtml(hand, noExtra)
    const spans = parseSpans(html)
    assert.equal(spans.length, 3)
  })

  it('renders cards in hand order', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'clubs', rank: '2' },
    ]
    const html = handSpreadHtml(hand, noExtra)
    const sA = html.indexOf('data-rank="A"')
    const s2 = html.indexOf('data-rank="2"')
    assert.ok(sA < s2, 'Ace of spades should appear before 2 of clubs')
  })

  it('forwards extra CSS class returned by extraClsFn', { timeout: 2000 }, () => {
    const hand = [{ suit: 'spades', rank: 'A' }]
    const html = handSpreadHtml(hand, () => 'card-play')
    assert.ok(html.includes('card-play'))
  })

  it('does not add extra class when extraClsFn returns empty string', { timeout: 2000 }, () => {
    const hand = [{ suit: 'spades', rank: 'A' }]
    const html = handSpreadHtml(hand, noExtra)
    assert.ok(!html.includes('card-play'))
  })

  it('marks suit cards with suit-specific color class', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'hearts', rank: '5' },
      { suit: 'spades', rank: '5' },
    ]
    const html = handSpreadHtml(hand, noExtra)
    // Hearts card should get card-hearts; spades card should get card-spades
    const heartsIdx = html.indexOf('data-suit="hearts"')
    const spadesIdx = html.indexOf('data-suit="spades"')
    // Grab the class attributes from each span block
    const heartsSpan = html.slice(html.lastIndexOf('<span', heartsIdx), heartsIdx)
    const spadesSpan = html.slice(html.lastIndexOf('<span', spadesIdx), spadesIdx)
    assert.ok(heartsSpan.includes('card-hearts'))
    assert.ok(!spadesSpan.includes('card-hearts'))
    assert.ok(spadesSpan.includes('card-spades'))
  })
})

// ---------------------------------------------------------------------------
// handDiagramHtml — Hand Diagram mode
// ---------------------------------------------------------------------------

describe('handDiagramHtml', { timeout: 2000 }, () => {
  it('returns empty string for an empty hand', { timeout: 2000 }, () => {
    assert.equal(handDiagramHtml([], noExtra), '')
  })

  it('creates one diagram-row div per suit present', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: 'K' },
      { suit: 'spades', rank: '2' },
    ]
    const html = handDiagramHtml(hand, noExtra)
    const rows = (html.match(/class="diagram-row"/g) || []).length
    assert.equal(rows, 2, 'only suits with cards should produce a row')
  })

  it('omits suits with no cards', { timeout: 2000 }, () => {
    const hand = [{ suit: 'spades', rank: 'A' }]
    const html = handDiagramHtml(hand, noExtra)
    assert.ok(!html.includes('\u2665'), 'hearts symbol should not appear')
    assert.ok(!html.includes('\u2666'), 'diamonds symbol should not appear')
    assert.ok(!html.includes('\u2663'), 'clubs symbol should not appear')
  })

  it('shows the suit symbol at the start of each row', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: 'K' },
    ]
    const html = handDiagramHtml(hand, noExtra)
    assert.ok(html.includes('class="diagram-suit suit-spades"'), 'spades row should have suit-spades class')
    assert.ok(html.includes('class="diagram-suit suit-hearts"'), 'hearts row should have suit-hearts class')
  })

  it('renders all cards for a suit in a single row', { timeout: 2000 }, () => {
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

  it('adds card-compact class to every card in diagram mode', { timeout: 2000 }, () => {
    const hand = [
      { suit: 'spades', rank: 'A' },
      { suit: 'hearts', rank: 'K' },
    ]
    const html = handDiagramHtml(hand, noExtra)
    const cardSpans = (html.match(/card-compact/g) || []).length
    assert.equal(cardSpans, 2)
  })

  it('forwards extra CSS class alongside card-compact', { timeout: 2000 }, () => {
    const hand = [{ suit: 'spades', rank: 'A' }]
    const html = handDiagramHtml(hand, () => 'card-sel')
    assert.ok(html.includes('card-compact card-sel'))
  })

  it('suit order is spades, hearts, diamonds, clubs', { timeout: 2000 }, () => {
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

describe('lastTrickHtml', { timeout: 2000 }, () => {
  const rel = { me: 'south', right: 'east', across: 'north', left: 'west' }

  const fullTrick = {
    winner: 'north',
    plays: [
      { seat: 'north', card: { suit: 'spades', rank: 'A' } },
      { seat: 'east',  card: { suit: 'clubs',  rank: '2' } },
      { seat: 'south', card: { suit: 'hearts', rank: 'K' } },
      { seat: 'west',  card: { suit: 'diamonds', rank: 'Q' } },
    ],
  }

  it('renders all 4 cards', { timeout: 2000 }, () => {
    const html = lastTrickHtml(fullTrick, rel)
    assert.ok(html.includes('A\u2660'), 'should contain A♠')
    assert.ok(html.includes('2\u2663'), 'should contain 2♣')
    assert.ok(html.includes('K\u2665'), 'should contain K♥')
    assert.ok(html.includes('Q\u2666'), 'should contain Q♦')
  })

  it('shows "Won by You" when current player won', { timeout: 2000 }, () => {
    const trick = { winner: 'south', plays: fullTrick.plays }
    const html = lastTrickHtml(trick, rel)
    assert.ok(html.includes('Won by You'), 'should say "Won by You"')
  })

  it('shows capitalized seat name when an opponent won', { timeout: 2000 }, () => {
    const html = lastTrickHtml(fullTrick, rel)
    assert.ok(html.includes('Won by North'), 'should say "Won by North"')
  })

  it('applies suit-specific trick class to each card', { timeout: 2000 }, () => {
    const html = lastTrickHtml(fullTrick, rel)
    // each suit should have its own trick-<suit> class
    assert.ok(html.includes('trick-hearts'), 'hearts card should have trick-hearts class')
    assert.ok(html.includes('trick-diamonds'), 'diamonds card should have trick-diamonds class')
    assert.ok(html.includes('trick-spades'), 'spades card should have trick-spades class')
    assert.ok(html.includes('trick-clubs'), 'clubs card should have trick-clubs class')
  })

  it('does not mix up suit trick classes', { timeout: 2000 }, () => {
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
    assert.equal((html.match(/trick-hearts/g) || []).length, 0, 'no trick-hearts for black-only trick')
    assert.equal((html.match(/trick-diamonds/g) || []).length, 0, 'no trick-diamonds for black-only trick')
  })

  it('escapes HTML special characters in card rank', { timeout: 2000 }, () => {
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

  it('renders the overlay and modal wrapper elements', { timeout: 2000 }, () => {
    const html = lastTrickHtml(fullTrick, rel)
    assert.ok(html.includes('last-trick-overlay'), 'should include overlay element')
    assert.ok(html.includes('last-trick-modal'), 'should include modal element')
    assert.ok(html.includes('last-trick-close'), 'should include close button')
  })
})
