import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyLobbyEvent } from '../../../client/web/src/screens/lobby.js'

describe('applyLobbyEvent', { timeout: 2000 }, () => {
  it('TABLE_CREATED adds the table to the map', { timeout: 2000 }, () => {
    const tables = {}
    applyLobbyEvent(tables, {
      type: 'TABLE_CREATED',
      payload: { tableId: 'tbl-1', name: 'Test Table', host: 'player-1', seats: {}, visibility: 'public' },
    })
    assert.ok(tables['tbl-1'], 'table should be added')
    assert.equal(tables['tbl-1'].name, 'Test Table')
    assert.equal(tables['tbl-1'].tableId, 'tbl-1')
  })

  it('TABLE_UPDATED merges fields into an existing table', { timeout: 2000 }, () => {
    const tables = {
      'tbl-1': { tableId: 'tbl-1', name: 'Test', seats: { north: null, east: null, south: null, west: null }, visibility: 'public' },
    }
    applyLobbyEvent(tables, {
      type: 'TABLE_UPDATED',
      payload: { tableId: 'tbl-1', seats: { north: 'player-1', east: null, south: null, west: null }, visibility: 'public' },
    })
    assert.equal(tables['tbl-1'].seats.north, 'player-1', 'seats should be updated')
    assert.equal(tables['tbl-1'].name, 'Test', 'name should be preserved')
  })

  it('TABLE_UPDATED is a no-op for an unknown tableId', { timeout: 2000 }, () => {
    const tables = {}
    applyLobbyEvent(tables, {
      type: 'TABLE_UPDATED',
      payload: { tableId: 'unknown', name: 'X', visibility: 'public' },
    })
    assert.equal(Object.keys(tables).length, 0)
  })

  it('TABLE_REMOVED deletes the table from the map', { timeout: 2000 }, () => {
    const tables = { 'tbl-1': { tableId: 'tbl-1', name: 'Gone' } }
    applyLobbyEvent(tables, { type: 'TABLE_REMOVED', payload: { tableId: 'tbl-1' } })
    assert.equal(tables['tbl-1'], undefined, 'table should be removed')
  })

  it('TABLE_REMOVED is a no-op for an unknown tableId', { timeout: 2000 }, () => {
    const tables = { 'tbl-1': { tableId: 'tbl-1' } }
    applyLobbyEvent(tables, { type: 'TABLE_REMOVED', payload: { tableId: 'unknown' } })
    assert.ok(tables['tbl-1'], 'unrelated table should remain')
  })

  it('unknown event types are ignored without throwing', { timeout: 2000 }, () => {
    const tables = {}
    assert.doesNotThrow(() => {
      applyLobbyEvent(tables, { type: 'SOME_OTHER_EVENT', payload: {} })
    })
  })

  it('returns the same tables object (mutates in place)', { timeout: 2000 }, () => {
    const tables = {}
    const result = applyLobbyEvent(tables, {
      type: 'TABLE_CREATED',
      payload: { tableId: 'tbl-1', name: 'Test' },
    })
    assert.equal(result, tables)
  })
})
