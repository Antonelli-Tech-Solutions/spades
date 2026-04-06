import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tricksCountClass } from '../../../client/web/src/screens/game.js'

// tricksCountClass(bid, tricks, completedCount) returns the CSS modifier class
// for the tricks-taken number based on bid progress.
//
// Rules:
//   - 'bid-tricks--met'       : tricks >= bid (team made or exceeded their bid)
//   - 'bid-tricks--impossible': tricks + remaining < bid (cannot make bid)
//   - 'bid-tricks--needs-all' : tricks + remaining === bid (need every remaining trick)
//   - ''                      : otherwise (still achievable with room to spare)
//
// remaining = 13 - completedCount
// Priority: met > impossible > needs-all > default

describe('tricksCountClass', { timeout: 2000 }, () => {
  // ── bid met ──────────────────────────────────────────────────────────────
  it('returns bid-tricks--met when tricks equal bid', { timeout: 2000 }, () => {
    assert.equal(tricksCountClass(5, 5, 8), 'bid-tricks--met')
  })

  it('returns bid-tricks--met when tricks exceed bid (bags)', { timeout: 2000 }, () => {
    assert.equal(tricksCountClass(5, 7, 10), 'bid-tricks--met')
  })

  it('returns bid-tricks--met even when no tricks remain', { timeout: 2000 }, () => {
    assert.equal(tricksCountClass(5, 5, 13), 'bid-tricks--met')
  })

  // ── impossible ───────────────────────────────────────────────────────────
  it('returns bid-tricks--impossible when tricks + remaining < bid', { timeout: 2000 }, () => {
    // bid=8, tricks=3, remaining=4 → 3+4=7 < 8
    assert.equal(tricksCountClass(8, 3, 9), 'bid-tricks--impossible')
  })

  it('returns bid-tricks--impossible with zero tricks remaining', { timeout: 2000 }, () => {
    // bid=6, tricks=4, remaining=0 → cannot make 6
    assert.equal(tricksCountClass(6, 4, 13), 'bid-tricks--impossible')
  })

  // ── needs all ────────────────────────────────────────────────────────────
  it('returns bid-tricks--needs-all when team needs every remaining trick', { timeout: 2000 }, () => {
    // bid=8, tricks=5, remaining=3 → 5+3=8 exactly
    assert.equal(tricksCountClass(8, 5, 10), 'bid-tricks--needs-all')
  })

  it('returns bid-tricks--needs-all at start of hand when bid equals 13', { timeout: 2000 }, () => {
    // bid=13, tricks=0, remaining=13 → 0+13=13 exactly
    assert.equal(tricksCountClass(13, 0, 0), 'bid-tricks--needs-all')
  })

  // ── default (achievable with room to spare) ───────────────────────────────
  it('returns empty string when bid is achievable with room to spare', { timeout: 2000 }, () => {
    // bid=5, tricks=2, remaining=7 → 2+7=9 > 5, no pressure
    assert.equal(tricksCountClass(5, 2, 6), '')
  })

  it('returns empty string at start of hand with reasonable bid', { timeout: 2000 }, () => {
    assert.equal(tricksCountClass(4, 0, 0), '')
  })

  // ── no bid set ────────────────────────────────────────────────────────────
  it('returns empty string when bid is null', { timeout: 2000 }, () => {
    assert.equal(tricksCountClass(null, 0, 0), '')
  })

  it('returns empty string when bid is undefined', { timeout: 2000 }, () => {
    assert.equal(tricksCountClass(undefined, 3, 5), '')
  })
})
