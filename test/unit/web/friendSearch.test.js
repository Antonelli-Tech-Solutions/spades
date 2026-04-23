/**
 * TDD tests for the friend search flow (Issue #704).
 *
 * Issue #704: The Search button in the InfoPanel friends tab doesn't trigger
 * any API calls. Two root causes identified:
 *
 *   1. The `searchPlayers` API wrapper in api.js uses POST, but the server
 *      route is GET /api/players/search?username=<query>. It should use GET
 *      with a query parameter, matching the invitePanel's searchPlayersByUsername.
 *
 *   2. The `renderInfoPanel` function wires tab switching and collapse but
 *      never attaches a click handler on the `.friend-search-btn` button.
 *
 * This file covers (1) — the API wrapper contract. The event-wiring fix (2)
 * is verified via manual browser testing (DOM-dependent).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { searchPlayers } from '../../../client/web/src/api.js'

/* ------------------------------------------------------------------ */
/*  Test helpers — same pattern as invitePanel.test.js                 */
/* ------------------------------------------------------------------ */

function mockFetch(status, body) {
  return async (_url, _opts) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

function capturingFetch(status, body) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  fn.calls = calls
  return fn
}

/* ------------------------------------------------------------------ */
/*  searchPlayers API wrapper                                         */
/* ------------------------------------------------------------------ */

describe('searchPlayers API', { timeout: 2000 }, () => {
  it('uses GET method, not POST', { timeout: 2000 }, async () => {
    const spy = capturingFetch(200, { players: [] })
    await searchPlayers({ username: 'alice', sessionId: 'sess-1', playerId: 'p-1' }, spy)
    assert.equal(spy.calls.length, 1)
    const opts = spy.calls[0].opts || {}
    // The server route is GET /api/players/search — POST will 404.
    const method = (opts.method || 'GET').toUpperCase()
    assert.equal(method, 'GET', `expected GET but got ${method}`)
  })

  it('passes the username as a query parameter, not in the request body', { timeout: 2000 }, async () => {
    const spy = capturingFetch(200, { players: [] })
    await searchPlayers({ username: 'alice', sessionId: 'sess-1', playerId: 'p-1' }, spy)
    const url = spy.calls[0].url
    assert.ok(url.includes('/api/players/search'), `expected search URL, got ${url}`)
    assert.ok(url.includes('username=alice'), `expected username query param in URL, got ${url}`)
    // Should not have a request body
    const opts = spy.calls[0].opts || {}
    assert.ok(!opts.body, 'GET request should not have a body')
  })

  it('sends auth headers (x-session-id and x-player-id)', { timeout: 2000 }, async () => {
    const spy = capturingFetch(200, { players: [] })
    await searchPlayers({ username: 'bob', sessionId: 'sess-42', playerId: 'p-99' }, spy)
    const opts = spy.calls[0].opts || {}
    assert.equal(opts.headers['x-session-id'], 'sess-42')
    assert.equal(opts.headers['x-player-id'], 'p-99')
  })

  it('URL-encodes the username to prevent injection', { timeout: 2000 }, async () => {
    const spy = capturingFetch(200, { players: [] })
    await searchPlayers({ username: 'a b&c=d', sessionId: 's', playerId: 'p' }, spy)
    const url = spy.calls[0].url
    assert.ok(!url.includes('a b&c=d'), 'raw value must not appear unencoded')
    assert.ok(
      url.includes('a+b') || url.includes('a%20b'),
      'space should be encoded',
    )
  })

  it('returns the parsed response body on success', { timeout: 2000 }, async () => {
    const body = {
      players: [
        { playerId: 'p-1', username: 'alice' },
        { playerId: 'p-2', username: 'alicia' },
      ],
    }
    const result = await searchPlayers(
      { username: 'ali', sessionId: 's', playerId: 'p' },
      mockFetch(200, body),
    )
    assert.equal(result.players.length, 2)
    assert.equal(result.players[0].username, 'alice')
  })

  it('throws with status on 401 Unauthorized', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        searchPlayers(
          { username: 'ali', sessionId: 's', playerId: 'p' },
          mockFetch(401, { error: 'Unauthorized.' }),
        ),
      (err) => {
        assert.equal(err.status, 401)
        assert.ok(err.message.includes('Unauthorized'))
        return true
      },
    )
  })

  it('throws with status on 400 validation error', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        searchPlayers(
          { username: '', sessionId: 's', playerId: 'p' },
          mockFetch(400, { error: 'Username is required.' }),
        ),
      (err) => {
        assert.equal(err.status, 400)
        return true
      },
    )
  })

  it('throws with a generic message on 500', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        searchPlayers(
          { username: 'x', sessionId: 's', playerId: 'p' },
          mockFetch(500, { error: 'Internal server error' }),
        ),
      (err) => {
        assert.equal(err.status, 500)
        return true
      },
    )
  })

  it('handles an empty username gracefully', { timeout: 2000 }, async () => {
    const spy = capturingFetch(200, { players: [] })
    await searchPlayers({ username: '', sessionId: 's', playerId: 'p' }, spy)
    const url = spy.calls[0].url
    // Should still construct a valid URL even with empty username
    assert.ok(url.includes('/api/players/search'), `expected search URL, got ${url}`)
  })
})
