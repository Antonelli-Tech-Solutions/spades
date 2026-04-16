/**
 * Unit tests for the web lobby screen (Issue #674).
 *
 * These tests cover:
 *   - applyLobbyEvent — TABLE_CREATED / TABLE_UPDATED / TABLE_REMOVED handling
 *     including the new enriched fields: hostUsername, rulesetLabel,
 *     joinPolicy, canJoin.
 *   - tableRowHtml — the pure render helper for a single row. It should
 *     render host name, seat count ('X/4'), ruleset label, a join-policy
 *     badge, and conditionally show the Join button based on `canJoin`.
 *
 * Rendering a full screen requires DOM + sessionStorage + WebSocket globals,
 * which are out of scope for node:test unit tests. Instead we drive
 * `tableRowHtml` as a pure function that lobby.js must export.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyLobbyEvent, tableRowHtml } from '../../../client/web/src/screens/lobby.js'

function baseTable(overrides = {}) {
  return {
    tableId: 'tbl-1',
    name: 'Friday Night',
    host: 'player-1',
    hostUsername: 'alice',
    rulesetLabel: 'Standard',
    joinPolicy: 'open',
    canJoin: true,
    seats: {
      north: { playerId: 'player-1', username: 'alice', isBot: false },
      east: null,
      south: null,
      west: null,
    },
    seatsAvailable: 3,
    visibility: 'public',
    ...overrides,
  }
}

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

  it('TABLE_CREATED preserves enriched fields (hostUsername, rulesetLabel, joinPolicy, canJoin)', { timeout: 2000 }, () => {
    const tables = {}
    const payload = baseTable({
      tableId: 'tbl-2',
      hostUsername: 'bob',
      rulesetLabel: 'Standard',
      joinPolicy: 'friends',
      canJoin: false,
    })
    applyLobbyEvent(tables, { type: 'TABLE_CREATED', payload })
    assert.equal(tables['tbl-2'].hostUsername, 'bob')
    assert.equal(tables['tbl-2'].rulesetLabel, 'Standard')
    assert.equal(tables['tbl-2'].joinPolicy, 'friends')
    assert.equal(tables['tbl-2'].canJoin, false)
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

  it('TABLE_UPDATED merges enriched fields (canJoin flip, joinPolicy change)', { timeout: 2000 }, () => {
    const tables = { 'tbl-1': baseTable({ canJoin: true, joinPolicy: 'open' }) }
    applyLobbyEvent(tables, {
      type: 'TABLE_UPDATED',
      payload: { tableId: 'tbl-1', canJoin: false, joinPolicy: 'invite' },
    })
    assert.equal(tables['tbl-1'].canJoin, false, 'canJoin should update')
    assert.equal(tables['tbl-1'].joinPolicy, 'invite', 'joinPolicy should update')
    assert.equal(tables['tbl-1'].hostUsername, 'alice', 'unchanged enriched fields should be preserved')
    assert.equal(tables['tbl-1'].rulesetLabel, 'Standard', 'rulesetLabel should be preserved')
  })

  it('TABLE_UPDATED updates hostUsername when host is transferred', { timeout: 2000 }, () => {
    const tables = { 'tbl-1': baseTable({ hostUsername: 'alice' }) }
    applyLobbyEvent(tables, {
      type: 'TABLE_UPDATED',
      payload: { tableId: 'tbl-1', host: 'player-2', hostUsername: 'bob' },
    })
    assert.equal(tables['tbl-1'].hostUsername, 'bob')
    assert.equal(tables['tbl-1'].host, 'player-2')
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

describe('tableRowHtml', { timeout: 2000 }, () => {
  it('renders the table name', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ name: 'Friday Night' }))
    assert.match(html, /Friday Night/)
  })

  it('renders the host username', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ hostUsername: 'alice' }))
    assert.match(html, /alice/, 'host username should appear in row')
  })

  it('renders seat occupancy in X/4 format', { timeout: 2000 }, () => {
    // 1 occupied seat -> "1/4"
    const html = tableRowHtml(baseTable())
    assert.match(html, /1\/4/, 'should render seat count as 1/4')
  })

  it('renders 3/4 when three seats are occupied', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({
      seats: {
        north: { playerId: 'p1', username: 'alice', isBot: false },
        east: { playerId: 'p2', username: 'bob', isBot: false },
        south: { playerId: 'p3', username: 'carol', isBot: false },
        west: null,
      },
      seatsAvailable: 1,
    }))
    assert.match(html, /3\/4/)
  })

  it('renders 4/4 when all seats are occupied', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({
      seats: {
        north: { playerId: 'p1', username: 'alice', isBot: false },
        east: { playerId: 'p2', username: 'bob', isBot: false },
        south: { playerId: 'p3', username: 'carol', isBot: false },
        west: { playerId: 'p4', username: 'dan', isBot: false },
      },
      seatsAvailable: 0,
    }))
    assert.match(html, /4\/4/)
  })

  it('renders the ruleset label', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ rulesetLabel: 'Standard' }))
    assert.match(html, /Standard/)
  })

  it('renders a different ruleset label when provided', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ rulesetLabel: 'Whiz' }))
    assert.match(html, /Whiz/)
  })

  it('renders an Open join-policy badge', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ joinPolicy: 'open' }))
    assert.match(html, /Open/i)
  })

  it('renders a Friends-Only join-policy badge', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ joinPolicy: 'friends' }))
    assert.match(html, /Friends/i)
  })

  it('renders an Invite-Only join-policy badge', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ joinPolicy: 'invite' }))
    assert.match(html, /Invite/i)
  })

  it('shows the Join button when canJoin is true', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ canJoin: true }))
    assert.match(html, /class="[^"]*join-seat-btn[^"]*"/, 'join button should be present')
  })

  it('hides the Join button when canJoin is false', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ canJoin: false }))
    assert.doesNotMatch(html, /class="[^"]*join-seat-btn[^"]*"/, 'join button should not be rendered')
  })

  it('hides the Join button when canJoin is false even if seats are available', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ canJoin: false, seatsAvailable: 3 }))
    assert.doesNotMatch(html, /join-seat-btn/)
  })

  it('escapes HTML in hostUsername to prevent XSS', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ hostUsername: '<script>alert(1)</script>' }))
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /&lt;script&gt;/)
  })

  it('escapes HTML in table name', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ name: '<img src=x>' }))
    assert.doesNotMatch(html, /<img src=x>/)
    assert.match(html, /&lt;img/)
  })

  it('escapes HTML in rulesetLabel', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ rulesetLabel: '<b>Evil</b>' }))
    assert.doesNotMatch(html, /<b>Evil<\/b>/)
    assert.match(html, /&lt;b&gt;Evil/)
  })

  it('includes the tableId as a data attribute', { timeout: 2000 }, () => {
    const html = tableRowHtml(baseTable({ tableId: 'tbl-xyz' }))
    assert.match(html, /data-table-id="tbl-xyz"/)
  })

  it('handles missing hostUsername gracefully', { timeout: 2000 }, () => {
    assert.doesNotThrow(() => {
      tableRowHtml(baseTable({ hostUsername: null }))
    })
  })

  it('handles missing rulesetLabel gracefully', { timeout: 2000 }, () => {
    assert.doesNotThrow(() => {
      tableRowHtml(baseTable({ rulesetLabel: null }))
    })
  })

  it('handles missing joinPolicy gracefully', { timeout: 2000 }, () => {
    assert.doesNotThrow(() => {
      tableRowHtml(baseTable({ joinPolicy: undefined }))
    })
  })

  it('treats missing canJoin as falsy and hides the Join button', { timeout: 2000 }, () => {
    // If the server omits canJoin, be conservative and hide the button
    // rather than showing a button that will fail on click.
    const table = baseTable()
    delete table.canJoin
    const html = tableRowHtml(table)
    assert.doesNotMatch(html, /join-seat-btn/)
  })
})
