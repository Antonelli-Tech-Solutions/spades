import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { teamBidTricksHtml } from '../../../client/web/src/screens/game.js'

// teamBidTricksHtml(state) renders the N/S and E/W bid-vs-tricks indicator bar.
//
// Bug: between CARD_PLAYED (4th card) and TRICK_COMPLETE, state.tricksWon and
// state.completedTricks are both stale by 1 for the trick that just completed.
// teamBidTricksHtml must account for an in-flight complete trick (all 4 cards in
// currentTrick) so the displayed count and CSS class stay accurate in that window.

describe('teamBidTricksHtml', { timeout: 2000 }, () => {
  const baseState = {
    phase: 'playing',
    teamBids: { ns: 7, ew: 6 },
    tricksWon: { north: 0, east: 0, south: 0, west: 0 },
    currentTrick: [],
    completedTricks: [],
    currentPlayerSeat: 'north',
    spadesbroken: false,
  }

  // ── Normal steady-state rendering ─────────────────────────────────────────

  it('shows zero tricks at start of hand', { timeout: 2000 }, () => {
    const html = teamBidTricksHtml(baseState)
    assert.ok(html.includes('<strong>0</strong>'), 'should show 0 tricks for NS')
  })

  it('shows updated tricks after TRICK_COMPLETE (completedTricks and tricksWon both updated)', { timeout: 2000 }, () => {
    const state = {
      ...baseState,
      tricksWon: { north: 4, east: 2, south: 2, west: 1 },
      completedTricks: Array(9).fill({ winner: 'north', plays: [] }),
      currentTrick: [],
      currentPlayerSeat: 'north',
    }
    const html = teamBidTricksHtml(state)
    // NS: north 4 + south 2 = 6
    assert.ok(html.includes('Tricks <strong>6</strong>'), 'NS should show 6 tricks')
    // EW: east 2 + west 1 = 3
    assert.ok(html.includes('Tricks <strong>3</strong>'), 'EW should show 3 tricks')
  })

  // ── Off-by-1 regression: in-flight complete trick ─────────────────────────
  //
  // After CARD_PLAYED (4th card), state.currentTrick has 4 entries and
  // state.currentPlayerSeat is the trick winner (set by the CARD_PLAYED handler
  // using nextPlayerSeat from the server). But state.tricksWon and
  // state.completedTricks are not yet updated (they're updated by TRICK_COMPLETE).
  //
  // Before the fix, this window caused the indicator to show one fewer trick for
  // the winning team and the wrong CSS class.

  it('does not show off-by-1 tricks for winning team in CARD_PLAYED/TRICK_COMPLETE window', { timeout: 2000 }, () => {
    // 10 tricks completed; NS has 6 tricks (bid 7), EW has 4 (bid 6).
    // Trick 11 just completed in currentTrick — north won.
    // currentPlayerSeat = 'north' (the winner, set by CARD_PLAYED handler).
    // tricksWon and completedTricks are stale (not yet updated).
    const state = {
      ...baseState,
      teamBids: { ns: 7, ew: 6 },
      tricksWon: { north: 4, east: 3, south: 2, west: 1 },
      completedTricks: Array(10).fill({ winner: 'north', plays: [] }),
      currentTrick: [
        { seat: 'north', card: { suit: 'spades', rank: 'A' } },
        { seat: 'east', card: { suit: 'spades', rank: '2' } },
        { seat: 'south', card: { suit: 'hearts', rank: '3' } },
        { seat: 'west', card: { suit: 'diamonds', rank: '4' } },
      ],
      currentPlayerSeat: 'north',
    }

    const html = teamBidTricksHtml(state)

    // NS: north 4 + south 2 + 1 (inferred win by north) = 7
    // Before fix: would show 6 (stale tricksWon) → wrong
    assert.ok(html.includes('Tricks <strong>7</strong>'), 'NS should show 7 (includes in-flight win)')

    // With 11 tricks done (10 + 1 in-flight) and NS at 7 = bid → bid-tricks--met
    // Before fix: completedCount=10 remaining=3, 6+3=9>7 → '' (wrong class)
    assert.ok(html.includes('bid-tricks--met'), 'NS should show bid-tricks--met class')
  })

  it('does not incorrectly credit in-flight trick to the losing team', { timeout: 2000 }, () => {
    // Same scenario as above: north wins trick 11.
    const state = {
      ...baseState,
      teamBids: { ns: 7, ew: 6 },
      tricksWon: { north: 4, east: 3, south: 2, west: 1 },
      completedTricks: Array(10).fill({ winner: 'north', plays: [] }),
      currentTrick: [
        { seat: 'north', card: { suit: 'spades', rank: 'A' } },
        { seat: 'east', card: { suit: 'spades', rank: '2' } },
        { seat: 'south', card: { suit: 'hearts', rank: '3' } },
        { seat: 'west', card: { suit: 'diamonds', rank: '4' } },
      ],
      currentPlayerSeat: 'north',
    }

    const html = teamBidTricksHtml(state)

    // EW: east 3 + west 1 = 4 (no in-flight win for EW since north won)
    assert.ok(html.includes('Tricks <strong>4</strong>'), 'EW should still show 4 (not credited)')
  })

  it('correctly shows completed count for tricksCountClass when trick is in-flight', { timeout: 2000 }, () => {
    // 11 tricks completed (via completedTricks); trick 12 is in-flight (currentTrick has 4 cards).
    // NS bid=7, NS tricks (stale)=6, but north wins the in-flight trick → should be 7 = bid-tricks--met.
    // EW bid=6, EW tricks (stale)=5, north not on EW → EW still 5.
    // With completedCount=12 (11+1), remaining=1. EW: 5+1=6=bid → bid-tricks--needs-all.
    const state = {
      ...baseState,
      teamBids: { ns: 7, ew: 6 },
      tricksWon: { north: 5, east: 4, south: 1, west: 1 },
      completedTricks: Array(11).fill({ winner: 'north', plays: [] }),
      currentTrick: [
        { seat: 'north', card: { suit: 'spades', rank: 'A' } },
        { seat: 'east', card: { suit: 'clubs', rank: '5' } },
        { seat: 'south', card: { suit: 'hearts', rank: '3' } },
        { seat: 'west', card: { suit: 'diamonds', rank: '4' } },
      ],
      currentPlayerSeat: 'north',
    }

    const html = teamBidTricksHtml(state)

    // NS: 5 + 1 + 1(inferred north wins) = 7 >= bid=7 → bid-tricks--met
    assert.ok(html.includes('bid-tricks--met'), 'NS should be bid-tricks--met')
    // EW: 4 + 1 = 5, completedCount=12 remaining=1, 5+1=6=bid → bid-tricks--needs-all
    assert.ok(html.includes('bid-tricks--needs-all'), 'EW should be bid-tricks--needs-all with 1 trick left')
  })

  it('skips in-flight winner credit on trick 13 (currentPlayerSeat not updated)', { timeout: 2000 }, () => {
    // On trick 13, nextPlayerSeat is null (new hand state). The CARD_PLAYED handler
    // keeps the old currentPlayerSeat. We must not credit that old seat as the winner.
    // Simply verify no crash and graceful output.
    const state = {
      ...baseState,
      teamBids: { ns: 7, ew: 6 },
      tricksWon: { north: 6, east: 4, south: 1, west: 2 },
      completedTricks: Array(12).fill({ winner: 'north', plays: [] }),
      currentTrick: [
        { seat: 'north', card: { suit: 'spades', rank: 'A' } },
        { seat: 'east', card: { suit: 'clubs', rank: '5' } },
        { seat: 'south', card: { suit: 'hearts', rank: '3' } },
        { seat: 'west', card: { suit: 'diamonds', rank: '4' } },
      ],
      currentPlayerSeat: 'west',  // old value, NOT the winner (winner is north)
    }

    const html = teamBidTricksHtml(state)
    // No crash; trick 13 in-flight credit is skipped
    assert.ok(typeof html === 'string')
    // NS: north 6 + south 1 = 7 (no in-flight credit on trick 13)
    assert.ok(html.includes('Tricks <strong>7</strong>'), 'NS shows 7 without wrong credit on trick 13')
  })
})
