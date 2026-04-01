import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isTableFull } from '../../../server/lobby/table.js'

describe('isTableFull', () => {
  it('returns false when all seats are empty', () => {
    const table = { seats: { north: null, east: null, south: null, west: null } }
    assert.equal(isTableFull(table), false)
  })

  it('returns false with 1 player seated', () => {
    const table = { seats: { north: 'player-1', east: null, south: null, west: null } }
    assert.equal(isTableFull(table), false)
  })

  it('returns false with 2 players seated', () => {
    const table = { seats: { north: 'player-1', east: 'player-2', south: null, west: null } }
    assert.equal(isTableFull(table), false)
  })

  it('returns false with 3 players seated', () => {
    const table = { seats: { north: 'player-1', east: 'player-2', south: 'player-3', west: null } }
    assert.equal(isTableFull(table), false)
  })

  it('returns true when all 4 seats are filled', () => {
    const table = {
      seats: { north: 'player-1', east: 'player-2', south: 'player-3', west: 'player-4' },
    }
    assert.equal(isTableFull(table), true)
  })
})
