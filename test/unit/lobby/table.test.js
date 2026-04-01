import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isTableFull } from '../../../server/lobby/table.js'

function makeTable(overrides = {}) {
  return {
    tableId: 'test-table-id',
    hostPlayerId: 'player-1',
    name: null,
    seats: { north: null, east: null, south: null, west: null },
    status: 'waiting',
    gameId: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('isTableFull', () => {
  it('returns false when no seats are filled (0/4)', () => {
    const table = makeTable()
    assert.equal(isTableFull(table), false)
  })

  it('returns false when 1 seat is filled (1/4)', () => {
    const table = makeTable({ seats: { north: 'player-1', east: null, south: null, west: null } })
    assert.equal(isTableFull(table), false)
  })

  it('returns false when 2 seats are filled (2/4)', () => {
    const table = makeTable({ seats: { north: 'player-1', east: 'player-2', south: null, west: null } })
    assert.equal(isTableFull(table), false)
  })

  it('returns false when 3 seats are filled (3/4)', () => {
    const table = makeTable({
      seats: { north: 'player-1', east: 'player-2', south: 'player-3', west: null },
    })
    assert.equal(isTableFull(table), false)
  })

  it('returns true when all 4 seats are filled (4/4)', () => {
    const table = makeTable({
      seats: {
        north: 'player-1',
        east: 'player-2',
        south: 'player-3',
        west: 'player-4',
      },
    })
    assert.equal(isTableFull(table), true)
  })
})
