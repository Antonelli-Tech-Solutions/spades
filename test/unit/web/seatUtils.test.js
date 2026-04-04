import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { relSeats } from '../../../client/web/src/seatUtils.js'

// In a standard card game, play passes to the LEFT (clockwise from above).
// Each player faces the player across from them; the clockwise neighbour is
// physically to their left.
//
// Seat layout (player perspective from the bottom seat):
//
//        [across]
//  [left]        [right]
//        [ me  ]
//
// CW order: north → east → south → west → north

describe('relSeats', { timeout: 2000 }, () => {
  it('south: left=west (clockwise), right=east, across=north', { timeout: 2000 }, () => {
    const rel = relSeats('south')
    assert.equal(rel.me, 'south')
    assert.equal(rel.left, 'west',  'clockwise from south is west — to south\'s left')
    assert.equal(rel.across, 'north')
    assert.equal(rel.right, 'east', 'counter-clockwise from south is east — to south\'s right')
  })

  it('north: left=east (clockwise), right=west, across=south', { timeout: 2000 }, () => {
    const rel = relSeats('north')
    assert.equal(rel.me, 'north')
    assert.equal(rel.left, 'east',  'clockwise from north is east — to north\'s left')
    assert.equal(rel.across, 'south')
    assert.equal(rel.right, 'west', 'counter-clockwise from north is west — to north\'s right')
  })

  it('east: left=south (clockwise), right=north, across=west', { timeout: 2000 }, () => {
    const rel = relSeats('east')
    assert.equal(rel.me, 'east')
    assert.equal(rel.left, 'south', 'clockwise from east is south — to east\'s left')
    assert.equal(rel.across, 'west')
    assert.equal(rel.right, 'north', 'counter-clockwise from east is north — to east\'s right')
  })

  it('west: left=north (clockwise), right=south, across=east', { timeout: 2000 }, () => {
    const rel = relSeats('west')
    assert.equal(rel.me, 'west')
    assert.equal(rel.left, 'north', 'clockwise from west is north — to west\'s left')
    assert.equal(rel.across, 'east')
    assert.equal(rel.right, 'south', 'counter-clockwise from west is south — to west\'s right')
  })

  it('play order passes left: me → left → across → right → me', { timeout: 2000 }, () => {
    // Starting from each seat, four left-turns should return to the same seat
    for (const start of ['north', 'east', 'south', 'west']) {
      let seat = start
      for (let i = 0; i < 4; i++) seat = relSeats(seat).left
      assert.equal(seat, start, `four left-turns from ${start} should return to ${start}`)
    }
  })
})
