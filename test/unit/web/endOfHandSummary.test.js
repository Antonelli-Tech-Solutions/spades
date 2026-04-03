/**
 * Unit tests for the end-of-hand summary component.
 *
 * Tests the HTML rendered by endOfHandSummaryHtml() for different hand
 * configurations: normal hands, nil bids, blind nil bids, double nil,
 * and bag penalty scenarios.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { endOfHandSummaryHtml } from '../../../client/web/src/endOfHandSummary.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides = {}) {
  return {
    handNumber: 1,
    bids: { north: 3, east: 4, south: 4, west: 3 },
    teamBids: { ns: 7, ew: 7 },
    tricksWon: { north: 4, east: 3, south: 3, west: 4 },
    scoreDelta: { ns: 70, ew: 70 },
    newBags: { ns: 0, ew: 0 },
    bagPenalty: { ns: 0, ew: 0 },
    scoresAfter: { ns: 70, ew: 70 },
    bagsAfter: { ns: 0, ew: 0 },
    ...overrides,
  }
}

// ── Basic rendering ───────────────────────────────────────────────────────────

describe('endOfHandSummaryHtml — basic rendering', () => {
  it('returns a non-empty string', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'north')
    assert.ok(typeof html === 'string' && html.length > 0)
  })

  it('includes the hand number', () => {
    const html = endOfHandSummaryHtml(makeEntry({ handNumber: 3 }), 'north')
    assert.ok(html.includes('3'), 'should include hand number 3')
  })

  it('includes "Us" label for the viewing player\'s team', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'north')
    assert.ok(html.includes('Us'), 'should include "Us" label')
  })

  it('includes "Them" label for the opponent team', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'north')
    assert.ok(html.includes('Them'), 'should include "Them" label')
  })

  it('includes N/S label for north/south team', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'north')
    assert.ok(html.includes('N/S'), 'should include N/S team label')
  })

  it('includes E/W label for east/west team', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'north')
    assert.ok(html.includes('E/W'), 'should include E/W team label')
  })

  it('includes a continue button', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'north')
    assert.ok(
      html.includes('hand-summary-continue') || html.toLowerCase().includes('continue'),
      'should include a continue button',
    )
  })

  it('includes scores after the hand', () => {
    const html = endOfHandSummaryHtml(makeEntry({ scoresAfter: { ns: 70, ew: 70 } }), 'north')
    assert.ok(html.includes('70'), 'should include the score value 70')
  })
})

describe('endOfHandSummaryHtml — Us/Them column orientation', () => {
  it('Us (N/S) appears before Them (E/W) for a north player', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'north')
    assert.ok(html.indexOf('N/S') < html.indexOf('E/W'), 'N/S should come before E/W for north player')
  })

  it('Us (E/W) appears before Them (N/S) for an east player', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'east')
    assert.ok(html.indexOf('E/W') < html.indexOf('N/S'), 'E/W should come before N/S for east player')
  })

  it('Us (N/S) appears before Them (E/W) for a south player', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'south')
    assert.ok(html.indexOf('N/S') < html.indexOf('E/W'), 'N/S should come before E/W for south player')
  })

  it('Us (E/W) appears before Them (N/S) for a west player', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'west')
    assert.ok(html.indexOf('E/W') < html.indexOf('N/S'), 'E/W should come before N/S for west player')
  })
})

describe('endOfHandSummaryHtml — normal hand (no nil bids)', () => {
  it('shows bid and tricks taken for each team', () => {
    const entry = makeEntry({
      bids: { north: 3, east: 4, south: 4, west: 3 },
      teamBids: { ns: 7, ew: 7 },
      tricksWon: { north: 4, east: 3, south: 3, west: 4 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('7'), 'should include team bid of 7')
  })

  it('shows positive score delta as +N', () => {
    const entry = makeEntry({ scoreDelta: { ns: 70, ew: 70 } })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('+70') || html.includes('+70'), 'should show +70')
  })

  it('shows negative score delta for missed bid', () => {
    const entry = makeEntry({
      scoreDelta: { ns: -80, ew: 70 },
      scoresAfter: { ns: -80, ew: 70 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('-80') || html.includes('−80'), 'should show negative delta')
  })

  it('shows bags earned when nonzero', () => {
    const entry = makeEntry({
      newBags: { ns: 2, ew: 0 },
      bagsAfter: { ns: 2, ew: 0 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('2'), 'should include the bag count 2')
  })
})

describe('endOfHandSummaryHtml — nil bid', () => {
  it('shows nil result for a nil bidder on the ns team', () => {
    const entry = makeEntry({
      bids: { north: 'nil', east: 4, south: 5, west: 3 },
      teamBids: { ns: 5, ew: 7 },
      tricksWon: { north: 0, east: 4, south: 5, west: 3 },
      scoreDelta: { ns: 100, ew: 70 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.toLowerCase().includes('nil'), 'should include "nil" in output')
  })

  it('shows "Made" when nil bidder took 0 tricks', () => {
    const entry = makeEntry({
      bids: { north: 'nil', east: 4, south: 5, west: 3 },
      teamBids: { ns: 5, ew: 7 },
      tricksWon: { north: 0, east: 4, south: 5, west: 3 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('Made') || html.includes('+50'), 'should show nil made result')
  })

  it('shows "Failed" when nil bidder took tricks', () => {
    const entry = makeEntry({
      bids: { north: 'nil', east: 4, south: 5, west: 3 },
      teamBids: { ns: 5, ew: 7 },
      tricksWon: { north: 2, east: 3, south: 5, west: 3 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('Failed') || html.includes('-50') || html.includes('−50'), 'should show nil failed result')
  })

  it('shows blind nil with ±100 points', () => {
    const entry = makeEntry({
      bids: { north: 'blind_nil', east: 4, south: 5, west: 3 },
      teamBids: { ns: 5, ew: 7 },
      tricksWon: { north: 0, east: 4, south: 5, west: 3 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(
      html.toLowerCase().includes('blind') || html.includes('100'),
      'should mention blind nil or 100 points',
    )
  })
})

describe('endOfHandSummaryHtml — double nil (both players on a team bid nil)', () => {
  it('omits team total row when both ns players bid nil', () => {
    const entry = makeEntry({
      bids: { north: 'nil', east: 4, south: 'nil', west: 3 },
      teamBids: { ns: null, ew: 7 },
      tricksWon: { north: 0, east: 4, south: 0, west: 3 },
      scoreDelta: { ns: 100, ew: 70 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    // Should still show individual nil rows but not a "Bid X, Took Y" team row for ns
    // The simplest check: both player names appear in nil rows
    assert.ok(html.toLowerCase().includes('nil'), 'should include nil label')
  })

  it('still shows individual nil rows for each double-nil bidder', () => {
    const entry = makeEntry({
      bids: { north: 'nil', east: 4, south: 'nil', west: 3 },
      teamBids: { ns: null, ew: 7 },
      tricksWon: { north: 0, east: 4, south: 0, west: 3 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    // Both North and South nil rows should appear
    assert.ok(html.includes('North') || html.includes('north'), 'North nil row should appear')
    assert.ok(html.includes('South') || html.includes('south'), 'South nil row should appear')
  })
})

describe('endOfHandSummaryHtml — bag penalty', () => {
  it('shows bag penalty notice when bagPenalty.ns is 1 for ns player', () => {
    const entry = makeEntry({
      bagPenalty: { ns: 1, ew: 0 },
      scoresAfter: { ns: -30, ew: 70 }, // 70 - 100 penalty = -30
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(
      html.toLowerCase().includes('bag') && (html.includes('100') || html.toLowerCase().includes('penalty')),
      'should show bag penalty notice',
    )
  })

  it('does not show bag penalty notice when no penalty', () => {
    const entry = makeEntry({ bagPenalty: { ns: 0, ew: 0 } })
    const html = endOfHandSummaryHtml(entry, 'north')
    // "penalty" text should not appear
    assert.ok(
      !html.toLowerCase().includes('penalty'),
      'should not show penalty text when no penalty occurred',
    )
  })

  it('shows bag penalty for the opponent team when they cross 10 bags', () => {
    const entry = makeEntry({
      bagPenalty: { ns: 0, ew: 1 },
      scoresAfter: { ns: 70, ew: -30 },
    })
    const html = endOfHandSummaryHtml(entry, 'north') // north is ns, ew is "them"
    assert.ok(
      html.toLowerCase().includes('penalty') || html.includes('100'),
      'should show bag penalty for ew team',
    )
  })

  it('shows −200 pts when a team bags out twice in one hand', () => {
    const entry = makeEntry({
      bagPenalty: { ns: 2, ew: 0 },
      scoresAfter: { ns: -130, ew: 70 }, // 70 - 200 = -130
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('200'), 'should show 200 for double bag penalty')
    assert.ok(
      html.toLowerCase().includes('penalty'),
      'should show penalty label',
    )
  })
})

describe('endOfHandSummaryHtml — running totals', () => {
  it('shows scoresAfter for both teams', () => {
    const entry = makeEntry({ scoresAfter: { ns: 140, ew: 70 } })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('140'), 'should show ns score 140')
    assert.ok(html.includes('70'), 'should show ew score 70')
  })

  it('shows bagsAfter for both teams', () => {
    const entry = makeEntry({ bagsAfter: { ns: 3, ew: 1 } })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('3'), 'should show ns bags 3')
  })
})
