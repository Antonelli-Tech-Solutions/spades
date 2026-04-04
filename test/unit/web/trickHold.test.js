import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HOLD_DURATIONS, detectCompletedTrick, isHandTransition, trickHoldHtml } from '../../../client/web/src/trickHold.js'

// ---------------------------------------------------------------------------
// HOLD_DURATIONS
// ---------------------------------------------------------------------------

describe('HOLD_DURATIONS', { timeout: 2000 }, () => {
  it('exports slow duration of 2500 ms', { timeout: 2000 }, () => {
    assert.equal(HOLD_DURATIONS.slow, 2500)
  })

  it('exports normal duration of 1500 ms', { timeout: 2000 }, () => {
    assert.equal(HOLD_DURATIONS.normal, 1500)
  })

  it('exports fast duration of 800 ms', { timeout: 2000 }, () => {
    assert.equal(HOLD_DURATIONS.fast, 800)
  })
})

// ---------------------------------------------------------------------------
// isHandTransition
// ---------------------------------------------------------------------------

describe('isHandTransition', { timeout: 2000 }, () => {
  it('returns false when prevState is null', { timeout: 2000 }, () => {
    const next = { handHistory: [{}], phase: 'bidding' }
    assert.equal(isHandTransition(null, next), false)
  })

  it('returns false when nextState is null', { timeout: 2000 }, () => {
    assert.equal(isHandTransition({ handHistory: [] }, null), false)
  })

  it('returns false when handHistory length is unchanged', { timeout: 2000 }, () => {
    const prev = { handHistory: [{}], phase: 'playing' }
    const next = { handHistory: [{}], phase: 'playing' }
    assert.equal(isHandTransition(prev, next), false)
  })

  it('returns false when game_over even if handHistory grew', { timeout: 2000 }, () => {
    // game_over: completedTricks preserved, state is safe to render during hold
    const prev = { handHistory: [], phase: 'playing' }
    const next = { handHistory: [{}], phase: 'game_over' }
    assert.equal(isHandTransition(prev, next), false)
  })

  it('returns true when handHistory grew and phase is bidding (non-final hand transition)', { timeout: 2000 }, () => {
    // 13th trick scored: server moved to next hand's bidding phase;
    // client must keep prevState during hold to avoid showing next hand context
    const prev = { handHistory: [], phase: 'playing' }
    const next = { handHistory: [{}], phase: 'bidding' }
    assert.equal(isHandTransition(prev, next), true)
  })

  it('returns true when handHistory grew and phase is playing (bots already played tricks of new hand)', { timeout: 2000 }, () => {
    const prev = { handHistory: [{}], phase: 'playing' }
    const next = { handHistory: [{}, {}], phase: 'playing' }
    assert.equal(isHandTransition(prev, next), true)
  })

  it('handles missing handHistory arrays gracefully', { timeout: 2000 }, () => {
    const prev = {}
    const next = { phase: 'bidding' }
    assert.equal(isHandTransition(prev, next), false)
  })
})

// ---------------------------------------------------------------------------
// detectCompletedTrick
// ---------------------------------------------------------------------------

describe('detectCompletedTrick', { timeout: 2000 }, () => {
  const baseTrick = {
    winner: 'north',
    plays: [
      { seat: 'north', card: { suit: 'spades',   rank: 'A' } },
      { seat: 'east',  card: { suit: 'clubs',    rank: '2' } },
      { seat: 'south', card: { suit: 'hearts',   rank: 'K' } },
      { seat: 'west',  card: { suit: 'diamonds', rank: 'Q' } },
    ],
  }

  it('returns null when prevState is null', { timeout: 2000 }, () => {
    const next = { completedTricks: [baseTrick], currentTrick: [] }
    assert.equal(detectCompletedTrick(null, next), null)
  })

  it('returns null when nextState has no completedTricks array', { timeout: 2000 }, () => {
    const prev = { completedTricks: [] }
    assert.equal(detectCompletedTrick(prev, {}), null)
  })

  it('returns null when the completedTricks length is unchanged', { timeout: 2000 }, () => {
    const prev = { completedTricks: [baseTrick] }
    const next = { completedTricks: [baseTrick] }
    assert.equal(detectCompletedTrick(prev, next), null)
  })

  it('returns null when prevState has no completedTricks and next also has none', { timeout: 2000 }, () => {
    const prev = { completedTricks: [] }
    const next = { completedTricks: [] }
    assert.equal(detectCompletedTrick(prev, next), null)
  })

  it('returns the newly completed trick when completedTricks grows by one', { timeout: 2000 }, () => {
    const prev = { completedTricks: [], currentTrick: [{ seat: 'north', card: baseTrick.plays[0].card }] }
    const next = { completedTricks: [baseTrick], currentTrick: [] }
    const result = detectCompletedTrick(prev, next)
    assert.deepEqual(result, baseTrick)
  })

  it('returns the last trick when multiple tricks complete in one transition', { timeout: 2000 }, () => {
    const trick2 = { winner: 'south', plays: baseTrick.plays }
    const prev = { completedTricks: [], currentTrick: [] }
    const next = { completedTricks: [baseTrick, trick2], currentTrick: [] }
    const result = detectCompletedTrick(prev, next)
    assert.deepEqual(result, trick2)
  })

  it('handles prevState with missing completedTricks gracefully', { timeout: 2000 }, () => {
    const next = { completedTricks: [baseTrick] }
    const result = detectCompletedTrick({}, next)
    assert.deepEqual(result, baseTrick)
  })

  it('returns lastTrick from handHistory when the 13th trick resets completedTricks for a new hand', { timeout: 2000 }, () => {
    const lastTrick = {
      winner: 'east',
      plays: [
        { seat: 'north', card: { suit: 'spades',   rank: 'A' } },
        { seat: 'east',  card: { suit: 'spades',   rank: 'K' } },
        { seat: 'south', card: { suit: 'clubs',    rank: '2' } },
        { seat: 'west',  card: { suit: 'diamonds', rank: '3' } },
      ],
    }
    const prev = { completedTricks: Array(12).fill(baseTrick), handHistory: [] }
    const next = {
      completedTricks: [],  // reset for new hand
      handHistory: [{ lastTrick }],
    }
    const result = detectCompletedTrick(prev, next)
    assert.deepEqual(result, lastTrick)
  })

  it('returns null when handHistory grew but lastTrick is absent from the new entry', { timeout: 2000 }, () => {
    const prev = { completedTricks: Array(12).fill(baseTrick), handHistory: [] }
    const next = {
      completedTricks: [],
      handHistory: [{ handNumber: 1 }],
    }
    assert.equal(detectCompletedTrick(prev, next), null)
  })

  it('still detects via completedTricks for game_over (completedTricks preserved)', { timeout: 2000 }, () => {
    const lastTrick = { winner: 'west', plays: baseTrick.plays }
    const prev = { completedTricks: Array(12).fill(baseTrick), handHistory: [] }
    const next = {
      completedTricks: [...Array(12).fill(baseTrick), lastTrick],  // 13 tricks, not reset
      handHistory: [{ lastTrick }],
      phase: 'game_over',
    }
    const result = detectCompletedTrick(prev, next)
    assert.deepEqual(result, lastTrick)
  })
})

// ---------------------------------------------------------------------------
// trickHoldHtml
// ---------------------------------------------------------------------------

describe('trickHoldHtml', { timeout: 2000 }, () => {
  const rel = { me: 'south', right: 'east', across: 'north', left: 'west' }

  const trick = {
    winner: 'north',
    plays: [
      { seat: 'north', card: { suit: 'spades',   rank: 'A' } },
      { seat: 'east',  card: { suit: 'clubs',    rank: '2' } },
      { seat: 'south', card: { suit: 'hearts',   rank: 'K' } },
      { seat: 'west',  card: { suit: 'diamonds', rank: 'Q' } },
    ],
  }

  it('renders all 4 cards', { timeout: 2000 }, () => {
    const html = trickHoldHtml(trick, rel)
    assert.ok(html.includes('A\u2660'), 'should contain A♠')
    assert.ok(html.includes('2\u2663'), 'should contain 2♣')
    assert.ok(html.includes('K\u2665'), 'should contain K♥')
    assert.ok(html.includes('Q\u2666'), 'should contain Q♦')
  })

  it('shows "Won by You" when the current player is the winner', { timeout: 2000 }, () => {
    const t = { winner: 'south', plays: trick.plays }
    const html = trickHoldHtml(t, rel)
    assert.ok(html.includes('Won by You'), 'should say "Won by You"')
  })

  it('shows capitalized seat name when an opponent won', { timeout: 2000 }, () => {
    const html = trickHoldHtml(trick, rel)
    assert.ok(html.includes('Won by North'), 'should say "Won by North"')
  })

  it('includes trick-area--hold modifier class to signal hold state', { timeout: 2000 }, () => {
    const html = trickHoldHtml(trick, rel)
    assert.ok(html.includes('trick-area--hold'), 'should include hold modifier class')
  })

  it('includes the trick-winner-banner element', { timeout: 2000 }, () => {
    const html = trickHoldHtml(trick, rel)
    assert.ok(html.includes('trick-winner-banner'), 'should include winner banner element')
  })

  it('applies trick-red to red-suit cards only', { timeout: 2000 }, () => {
    const html = trickHoldHtml(trick, rel)
    // hearts (K) and diamonds (Q) should have trick-red — spades and clubs should not
    const redCount = (html.match(/trick-red/g) || []).length
    assert.equal(redCount, 2, 'exactly 2 red-suit cards should have trick-red')
  })

  it('does not apply trick-red to black-suit cards', { timeout: 2000 }, () => {
    const blackOnly = {
      winner: 'north',
      plays: [
        { seat: 'north', card: { suit: 'spades', rank: 'A' } },
        { seat: 'east',  card: { suit: 'clubs',  rank: '2' } },
        { seat: 'south', card: { suit: 'spades', rank: '3' } },
        { seat: 'west',  card: { suit: 'clubs',  rank: '4' } },
      ],
    }
    const html = trickHoldHtml(blackOnly, rel)
    assert.equal((html.match(/trick-red/g) || []).length, 0, 'no red class for black suits')
  })

  it('escapes HTML special characters in card ranks', { timeout: 2000 }, () => {
    const xssTrick = {
      winner: 'north',
      plays: [
        { seat: 'north', card: { suit: 'spades',   rank: '<b>' } },
        { seat: 'east',  card: { suit: 'clubs',    rank: '2' } },
        { seat: 'south', card: { suit: 'hearts',   rank: '3' } },
        { seat: 'west',  card: { suit: 'diamonds', rank: '4' } },
      ],
    }
    const html = trickHoldHtml(xssTrick, rel)
    assert.ok(!html.includes('<b>'), 'raw HTML should be escaped')
    assert.ok(html.includes('&lt;b&gt;'), 'should contain escaped version')
  })

  it('renders the trick-area wrapper element', { timeout: 2000 }, () => {
    const html = trickHoldHtml(trick, rel)
    assert.ok(html.includes('class="trick-area'), 'should include trick-area element')
  })

  it('renders positional rows for across, left, right, and me', { timeout: 2000 }, () => {
    const html = trickHoldHtml(trick, rel)
    assert.ok((html.match(/trick-row/g) || []).length >= 2, 'should have at least two trick-row elements')
    assert.ok(html.includes('trick-middle'), 'should include trick-middle row')
    assert.ok(html.includes('trick-center'), 'should include trick-center spacing element')
  })
})
