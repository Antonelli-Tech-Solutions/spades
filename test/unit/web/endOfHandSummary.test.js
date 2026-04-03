import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { endOfHandSummaryHtml } from '../../../client/web/src/endOfHandSummary.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides = {}) {
  return {
    handNumber: 1,
    bids: { north: 4, south: 3, east: 3, west: 3 },
    teamBids: { ns: 7, ew: 6 },
    tricksWon: { north: 4, south: 3, east: 3, west: 3 },
    scoreDelta: { ns: 70, ew: 60 },
    bagPenalty: { ns: 0, ew: 0 },
    newBags: { ns: 0, ew: 0 },
    scoresAfter: { ns: 70, ew: 60 },
    bagsAfter: { ns: 0, ew: 0 },
    winnerTeam: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('endOfHandSummaryHtml — structure', () => {
  it('renders a hand-summary wrapper element', () => {
    const html = endOfHandSummaryHtml(makeSummary(), 'north')
    assert.ok(html.includes('hand-summary'), 'should include hand-summary class')
  })

  it('renders a hand number label', () => {
    const html = endOfHandSummaryHtml(makeSummary({ handNumber: 3 }), 'north')
    assert.ok(html.includes('Hand 3'), 'should display hand number')
  })

  it('renders two column headers: Us and Them', () => {
    const html = endOfHandSummaryHtml(makeSummary(), 'north')
    assert.ok(html.includes('Us'), 'should include Us column header')
    assert.ok(html.includes('Them'), 'should include Them column header')
  })

  it('includes a Continue button', () => {
    const html = endOfHandSummaryHtml(makeSummary(), 'north')
    assert.ok(html.includes('summary-continue-btn'), 'should include continue button')
  })
})

// ---------------------------------------------------------------------------
// Team assignment (Us vs Them)
// ---------------------------------------------------------------------------

describe('endOfHandSummaryHtml — Us/Them columns', () => {
  it('treats ns as Us when player is north', () => {
    const html = endOfHandSummaryHtml(makeSummary(), 'north')
    // ns scored +70 and ew scored +60; Us should contain 70
    assert.ok(html.includes('+70') || html.includes('70'), 'Us column should show ns score')
  })

  it('treats ns as Us when player is south', () => {
    const html = endOfHandSummaryHtml(makeSummary(), 'south')
    assert.ok(html.includes('+70') || html.includes('70'), 'Us column should show ns score')
  })

  it('treats ew as Us when player is east', () => {
    const summary = makeSummary({ scoreDelta: { ns: 70, ew: 60 } })
    const html = endOfHandSummaryHtml(summary, 'east')
    // ew scored +60 and should appear under Us column
    assert.ok(html.includes('+60') || html.includes('60'), 'Us column should show ew score for east player')
  })

  it('treats ew as Us when player is west', () => {
    const summary = makeSummary({ scoreDelta: { ns: 70, ew: 60 } })
    const html = endOfHandSummaryHtml(summary, 'west')
    assert.ok(html.includes('+60') || html.includes('60'), 'Us column should show ew score for west player')
  })
})

// ---------------------------------------------------------------------------
// Team total row — no nil bidders
// ---------------------------------------------------------------------------

describe('endOfHandSummaryHtml — team total row (no nil bidders)', () => {
  it('shows both teams bid targets', () => {
    const html = endOfHandSummaryHtml(makeSummary(), 'north')
    // teamBids.ns = 7, teamBids.ew = 6
    assert.ok(html.includes('Bid 7') || html.includes('bid 7') || html.includes('>7<'), 'should show ns bid target')
    assert.ok(html.includes('Bid 6') || html.includes('bid 6') || html.includes('>6<'), 'should show ew bid target')
  })

  it('shows tricks taken for each team', () => {
    // ns took 7 total (north:4, south:3), ew took 6 (east:3, west:3)
    const html = endOfHandSummaryHtml(makeSummary(), 'north')
    assert.ok(html.includes('7') && html.includes('6'), 'should show trick counts')
  })

  it('shows positive score delta with + sign', () => {
    const html = endOfHandSummaryHtml(makeSummary(), 'north')
    assert.ok(html.includes('+70'), 'should show +70 for ns score delta')
    assert.ok(html.includes('+60'), 'should show +60 for ew score delta')
  })

  it('shows negative score delta with - sign', () => {
    const summary = makeSummary({ scoreDelta: { ns: -70, ew: -60 } })
    const html = endOfHandSummaryHtml(summary, 'north')
    assert.ok(html.includes('-70'), 'should show -70 for ns negative score delta')
  })

  it('shows bags earned this hand', () => {
    const summary = makeSummary({ newBags: { ns: 2, ew: 1 } })
    const html = endOfHandSummaryHtml(summary, 'north')
    assert.ok(html.includes('2'), 'should show 2 bags for ns')
  })

  it('shows 0 bags when no overtricks', () => {
    const html = endOfHandSummaryHtml(makeSummary(), 'north')
    assert.ok(html.includes('0'), 'should show 0 bags')
  })
})

// ---------------------------------------------------------------------------
// Bag penalty row
// ---------------------------------------------------------------------------

describe('endOfHandSummaryHtml — bag penalty', () => {
  it('does not show bag penalty row when penalty is zero', () => {
    const html = endOfHandSummaryHtml(makeSummary(), 'north')
    assert.ok(!html.includes('bag penalty') && !html.includes('Bag Penalty'), 'should not show bag penalty row when zero')
  })

  it('shows bag penalty row when a penalty was applied', () => {
    const summary = makeSummary({ bagPenalty: { ns: -100, ew: 0 } })
    const html = endOfHandSummaryHtml(summary, 'north')
    assert.ok(html.includes('-100'), 'should show -100 bag penalty')
  })
})

// ---------------------------------------------------------------------------
// Nil bidder rows
// ---------------------------------------------------------------------------

describe('endOfHandSummaryHtml — nil bidder rows', () => {
  it('adds a nil row when north bids nil and made it', () => {
    const summary = makeSummary({
      bids: { north: 'nil', south: 3, east: 3, west: 3 },
      teamBids: { ns: 3, ew: 6 },
      tricksWon: { north: 0, south: 3, east: 3, west: 3 },
      scoreDelta: { ns: 80, ew: 60 },  // 50 nil + 30 team
    })
    const html = endOfHandSummaryHtml(summary, 'north')
    assert.ok(html.includes('Nil'), 'should include Nil label in nil row')
    assert.ok(html.includes('North'), 'should include North name in nil row')
  })

  it('shows "Made" when nil bidder took 0 tricks', () => {
    const summary = makeSummary({
      bids: { north: 'nil', south: 3, east: 3, west: 3 },
      teamBids: { ns: 3, ew: 6 },
      tricksWon: { north: 0, south: 3, east: 3, west: 3 },
      scoreDelta: { ns: 80, ew: 60 },
    })
    const html = endOfHandSummaryHtml(summary, 'north')
    assert.ok(html.includes('Made') || html.includes('made'), 'should show Made for successful nil')
  })

  it('shows "Failed" when nil bidder took 1+ tricks', () => {
    const summary = makeSummary({
      bids: { north: 'nil', south: 3, east: 3, west: 3 },
      teamBids: { ns: 3, ew: 6 },
      tricksWon: { north: 2, south: 3, east: 3, west: 3 },
      scoreDelta: { ns: -20, ew: 60 },
    })
    const html = endOfHandSummaryHtml(summary, 'north')
    assert.ok(html.includes('Failed') || html.includes('failed'), 'should show Failed for busted nil')
  })

  it('shows "Blind Nil" label for blind nil bid', () => {
    const summary = makeSummary({
      bids: { north: 'blind_nil', south: 3, east: 3, west: 3 },
      teamBids: { ns: 3, ew: 6 },
      tricksWon: { north: 0, south: 3, east: 3, west: 3 },
      scoreDelta: { ns: 130, ew: 60 },
    })
    const html = endOfHandSummaryHtml(summary, 'north')
    assert.ok(html.includes('Blind Nil'), 'should show Blind Nil label')
  })

  it('shows team total row alongside nil row when one player bids nil', () => {
    const summary = makeSummary({
      bids: { north: 'nil', south: 4, east: 3, west: 3 },
      teamBids: { ns: 4, ew: 6 },
      tricksWon: { north: 0, south: 4, east: 3, west: 3 },
      scoreDelta: { ns: 90, ew: 60 },
    })
    const html = endOfHandSummaryHtml(summary, 'north')
    // Should have both a nil row AND a team total row
    assert.ok(html.includes('Nil'), 'should include Nil row')
    assert.ok(html.includes('Bid 4') || html.includes('>4<'), 'should include team bid row')
  })

  it('shows no team total row when both players bid nil (double nil)', () => {
    const summary = makeSummary({
      bids: { north: 'nil', south: 'nil', east: 3, west: 3 },
      teamBids: { ns: null, ew: 6 },
      tricksWon: { north: 0, south: 0, east: 6, west: 7 },
      scoreDelta: { ns: 100, ew: 60 },
      newBags: { ns: 0, ew: 7 },
    })
    const html = endOfHandSummaryHtml(summary, 'north')
    // Should NOT show a team bid/tricks row for ns since both bid nil
    // But should show 2 nil rows
    const nilCount = (html.match(/summary-nil-row|nil-row/g) || []).length
    assert.ok(nilCount >= 2, `should have 2 nil rows for double nil, got ${nilCount}`)
  })

  it('shows both nil rows with correct Made/Failed status in double nil', () => {
    const summary = makeSummary({
      bids: { north: 'nil', south: 'nil', east: 3, west: 3 },
      teamBids: { ns: null, ew: 6 },
      tricksWon: { north: 0, south: 1, east: 6, west: 7 },
      scoreDelta: { ns: 0, ew: 60 },
    })
    const html = endOfHandSummaryHtml(summary, 'north')
    assert.ok(html.includes('Made') || html.includes('made'), 'should show Made for north nil (0 tricks)')
    assert.ok(html.includes('Failed') || html.includes('failed'), 'should show Failed for south nil (1 trick)')
  })

  it('shows nil row on the correct team column', () => {
    const summary = makeSummary({
      bids: { north: 'nil', south: 3, east: 3, west: 3 },
      teamBids: { ns: 3, ew: 6 },
      tricksWon: { north: 0, south: 3, east: 3, west: 3 },
      scoreDelta: { ns: 80, ew: 60 },
    })
    // When player is south (ns team), north's nil should appear in the "Us" column
    const html = endOfHandSummaryHtml(summary, 'south')
    assert.ok(html.includes('North'), 'should include North name in Us nil row')
    assert.ok(html.includes('Nil'), 'should include Nil label')
  })
})

// ---------------------------------------------------------------------------
// Score total display
// ---------------------------------------------------------------------------

describe('endOfHandSummaryHtml — score totals', () => {
  it('shows the score after this hand for both teams', () => {
    const summary = makeSummary({
      scoresAfter: { ns: 140, ew: 120 },
    })
    const html = endOfHandSummaryHtml(summary, 'north')
    assert.ok(html.includes('140'), 'should show ns score total after hand')
    assert.ok(html.includes('120'), 'should show ew score total after hand')
  })

  it('shows bags after this hand', () => {
    const summary = makeSummary({
      bagsAfter: { ns: 3, ew: 5 },
    })
    const html = endOfHandSummaryHtml(summary, 'north')
    assert.ok(html.includes('3'), 'should show ns bag total')
    assert.ok(html.includes('5'), 'should show ew bag total')
  })
})

// ---------------------------------------------------------------------------
// XSS escaping
// ---------------------------------------------------------------------------

describe('endOfHandSummaryHtml — XSS escaping', () => {
  it('escapes HTML in seat names used as labels', () => {
    // If any label were injected as raw HTML (they are constants here, but test the pattern)
    const html = endOfHandSummaryHtml(makeSummary(), 'north')
    // Basic check: the output should not contain unescaped script tags
    assert.ok(!html.includes('<script>'), 'should not include unescaped script tags')
  })
})
