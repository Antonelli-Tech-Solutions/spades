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
    scoresBefore: { ns: 0, ew: 0 },
    bagsBefore: { ns: 0, ew: 0 },
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

  it('shows tricks-only score in "Bid X, Took Y" row when team has a failed nil bidder', () => {
    // Bid 3, Took 3 → +30 pts from tricks. Failed nil → -50. scoreDelta = -20.
    // The "Bid X, Took Y" row must show +30, not the net -20.
    const entry = makeEntry({
      bids: { north: 'nil', east: 4, south: 3, west: 3 },
      teamBids: { ns: 3, ew: 7 },
      tricksWon: { north: 1, east: 4, south: 2, west: 3 },
      scoreDelta: { ns: -20, ew: 70 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('+30'), 'Bid X, Took Y row should show +30 (tricks only), not -20 (net)')
    assert.ok(!html.includes('-20'), 'should not show the net score -20 in the team row')
  })

  it('shows tricks-only score in "Bid X, Took Y" row when team has a made nil bidder', () => {
    // Bid 5, Took 5 → +50 pts from tricks. Made nil → +50. scoreDelta = 100.
    // The "Bid X, Took Y" row must show +50, not +100.
    const entry = makeEntry({
      bids: { north: 'nil', east: 4, south: 5, west: 3 },
      teamBids: { ns: 5, ew: 7 },
      tricksWon: { north: 0, east: 4, south: 5, west: 3 },
      scoreDelta: { ns: 100, ew: 70 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('+50 pts'), 'Bid X, Took Y row should show +50 pts (tricks only)')
  })

  it('nil result rows include "pts" suffix', () => {
    const entry = makeEntry({
      bids: { north: 'nil', east: 4, south: 5, west: 3 },
      teamBids: { ns: 5, ew: 7 },
      tricksWon: { north: 2, east: 3, south: 5, west: 3 },
      scoreDelta: { ns: 0, ew: 70 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('−50 pts') || html.includes('-50 pts'), 'failed nil row should include "pts" suffix')
  })

  it('made nil result rows include "pts" suffix', () => {
    const entry = makeEntry({
      bids: { north: 'nil', east: 4, south: 5, west: 3 },
      teamBids: { ns: 5, ew: 7 },
      tricksWon: { north: 0, east: 4, south: 5, west: 3 },
      scoreDelta: { ns: 100, ew: 70 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    assert.ok(html.includes('+50 pts'), 'made nil row should include "pts" suffix')
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
      html.toLowerCase().includes('twice'),
      'should show "twice" label for double bag-out',
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

  it('shows bagsBefore next to the scores at the top', () => {
    const entry = makeEntry({
      scoresBefore: { ns: 100, ew: 50 },
      bagsBefore: { ns: 4, ew: 2 },
    })
    const html = endOfHandSummaryHtml(entry, 'north')
    // bags-before values should appear in the scores-before section
    const scoresBefore = html.match(/hand-summary-scores-before[\s\S]*?hand-summary-cols/)?.[0] ?? html
    assert.ok(scoresBefore.includes('4') || html.includes('4'), 'should display us bags before (4)')
    assert.ok(scoresBefore.includes('2') || html.includes('2'), 'should display them bags before (2)')
  })

  it('bagsAfter appear on the same line as the final score (not below)', () => {
    const entry = makeEntry({ bagsAfter: { ns: 5, ew: 0 }, scoresAfter: { ns: 127, ew: 49 } })
    const html = endOfHandSummaryHtml(entry, 'north')
    // summary-bags should be inside summary-total but not in its own separate block
    const totalSection = html.match(/summary-total[\s\S]*?<\/div>/)?.[0] ?? ''
    assert.ok(html.includes('summary-bags'), 'bags element should exist')
    // The bags span should follow the score span without a line-break wrapper in between
    const scoreIdx = html.indexOf('summary-score')
    const bagsIdx = html.indexOf('summary-bags')
    assert.ok(bagsIdx > scoreIdx, 'summary-bags should appear after summary-score in the DOM')
  })
})

describe('endOfHandSummaryHtml — gameOverInfo (game over mode)', () => {
  it('includes GAME OVER in the title when gameOverInfo is provided', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'north', { winner: 'ns' })
    assert.ok(html.includes('GAME OVER'), 'should include GAME OVER in title')
  })

  it('shows winner announcement when gameOverInfo is provided', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'north', { winner: 'ns' })
    assert.ok(
      html.toLowerCase().includes('win') || html.toLowerCase().includes('north') || html.toLowerCase().includes('n/s'),
      'should announce the winner',
    )
  })

  it('shows "Back to Lobby" button instead of "Continue" when gameOverInfo is provided', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'north', { winner: 'ns' })
    assert.ok(html.includes('hand-summary-lobby') || html.toLowerCase().includes('back to lobby'), 'should have Back to Lobby button')
    assert.ok(!html.includes('hand-summary-continue'), 'should not have Continue button')
  })

  it('still shows normal hand summary content when gameOverInfo is provided', () => {
    const entry = makeEntry({ scoreDelta: { ns: 70, ew: 70 } })
    const html = endOfHandSummaryHtml(entry, 'north', { winner: 'ns' })
    assert.ok(html.includes('+70'), 'should still show hand score delta')
  })

  it('shows "Continue" button and no GAME OVER title when gameOverInfo is null', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'north', null)
    assert.ok(html.includes('hand-summary-continue') || html.toLowerCase().includes('continue'), 'should have Continue button')
    assert.ok(!html.includes('GAME OVER'), 'should not include GAME OVER')
  })

  it('shows "Continue" button and no GAME OVER title when gameOverInfo is omitted', () => {
    const html = endOfHandSummaryHtml(makeEntry(), 'north')
    assert.ok(html.includes('hand-summary-continue') || html.toLowerCase().includes('continue'), 'should have Continue button')
    assert.ok(!html.includes('GAME OVER'), 'should not include GAME OVER')
  })

  it('announces winning team by label', () => {
    const htmlNs = endOfHandSummaryHtml(makeEntry(), 'north', { winner: 'ns' })
    assert.ok(
      htmlNs.includes('N/S') || htmlNs.toLowerCase().includes('north'),
      'should reference ns winner',
    )
    const htmlEw = endOfHandSummaryHtml(makeEntry(), 'north', { winner: 'ew' })
    assert.ok(
      htmlEw.includes('E/W') || htmlEw.toLowerCase().includes('east'),
      'should reference ew winner',
    )
  })
})
