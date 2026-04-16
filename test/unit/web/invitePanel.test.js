/**
 * Unit tests for the waiting-room Invite panel (Issue #679).
 *
 * These tests drive the creation of client/web/src/invitePanel.js, which
 * should expose pure helpers for:
 *   - shouldShowInviteControl({ isHost, status }) — visibility gate
 *   - inviteTablePlayer({ tableId, targetPlayerId, sessionId, playerId }, fetchFn)
 *       — POST /api/tables/:tableId/invite wrapper
 *   - searchPlayersByUsername({ username, sessionId, playerId }, fetchFn)
 *       — GET /api/players/search wrapper
 *   - createInviteSession() — per-session duplicate tracker with markInvited / hasInvited
 *   - isPlayerInvitable({ player, seatedPlayerIds, invitedPlayerIds })
 *       — disabled-button predicate
 *   - inviteFeedbackMessage({ status, username }) — success / 409 / generic text
 *   - invitePanelHtml({ friends, searchResults, seatedPlayerIds, invitedPlayerIds })
 *       — renders the panel body
 *
 * Server endpoint integration is covered by the server sub-issue's integration
 * tests; these unit tests mock fetch and exercise the client contract only.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldShowInviteControl,
  inviteTablePlayer,
  searchPlayersByUsername,
  createInviteSession,
  isPlayerInvitable,
  inviteFeedbackMessage,
  invitePanelHtml,
} from '../../../client/web/src/invitePanel.js'

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

describe('shouldShowInviteControl', { timeout: 2000 }, () => {
  it('returns true when the local player is the host and the table is waiting', { timeout: 2000 }, () => {
    assert.equal(shouldShowInviteControl({ isHost: true, status: 'waiting' }), true)
  })

  it('returns false when the local player is not the host', { timeout: 2000 }, () => {
    assert.equal(shouldShowInviteControl({ isHost: false, status: 'waiting' }), false)
  })

  it('returns false when the table has already left the waiting phase', { timeout: 2000 }, () => {
    assert.equal(shouldShowInviteControl({ isHost: true, status: 'bidding' }), false)
    assert.equal(shouldShowInviteControl({ isHost: true, status: 'playing' }), false)
    assert.equal(shouldShowInviteControl({ isHost: true, status: 'completed' }), false)
  })

  it('returns false when status is missing', { timeout: 2000 }, () => {
    assert.equal(shouldShowInviteControl({ isHost: true }), false)
  })

  it('returns false when both gates fail', { timeout: 2000 }, () => {
    assert.equal(shouldShowInviteControl({ isHost: false, status: 'playing' }), false)
  })
})

describe('inviteTablePlayer API', { timeout: 2000 }, () => {
  it('POSTs to /api/tables/:tableId/invite with { playerId } and auth headers', { timeout: 2000 }, async () => {
    const spy = capturingFetch(200, { ok: true })
    await inviteTablePlayer(
      { tableId: 't-1', targetPlayerId: 'p-target', sessionId: 'sess-1', playerId: 'p-host' },
      spy,
    )
    assert.equal(spy.calls.length, 1)
    assert.equal(spy.calls[0].url, '/api/tables/t-1/invite')
    const opts = spy.calls[0].opts || {}
    assert.equal(opts.method, 'POST')
    assert.equal(opts.headers['x-session-id'], 'sess-1')
    assert.equal(opts.headers['x-player-id'], 'p-host')
    assert.equal(opts.headers['Content-Type'], 'application/json')
    const body = JSON.parse(opts.body)
    assert.equal(body.playerId, 'p-target')
  })

  it('resolves with the response body on 200', { timeout: 2000 }, async () => {
    const result = await inviteTablePlayer(
      { tableId: 't-1', targetPlayerId: 'p-target', sessionId: 's', playerId: 'p' },
      mockFetch(200, { message: 'Invite sent' }),
    )
    assert.equal(result.message, 'Invite sent')
  })

  it('throws an error tagged with status 409 on duplicate invite', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        inviteTablePlayer(
          { tableId: 't-1', targetPlayerId: 'p-target', sessionId: 's', playerId: 'p' },
          mockFetch(409, { error: 'DUPLICATE_INVITE', code: 'DUPLICATE_INVITE' }),
        ),
      (err) => {
        assert.equal(err.status, 409)
        return true
      },
    )
  })

  it('throws with status 403 when the caller is not the host', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        inviteTablePlayer(
          { tableId: 't-1', targetPlayerId: 'p-target', sessionId: 's', playerId: 'p' },
          mockFetch(403, { error: 'Only the host can send invites' }),
        ),
      (err) => {
        assert.equal(err.status, 403)
        return true
      },
    )
  })

  it('throws with status 404 when the target player does not exist', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        inviteTablePlayer(
          { tableId: 't-1', targetPlayerId: 'p-target', sessionId: 's', playerId: 'p' },
          mockFetch(404, { error: 'Target player not found' }),
        ),
      (err) => {
        assert.equal(err.status, 404)
        return true
      },
    )
  })

  it('throws with status 500 on server error', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        inviteTablePlayer(
          { tableId: 't-1', targetPlayerId: 'p-target', sessionId: 's', playerId: 'p' },
          mockFetch(500, { error: 'Internal server error' }),
        ),
      (err) => {
        assert.equal(err.status, 500)
        return true
      },
    )
  })
})

describe('searchPlayersByUsername API', { timeout: 2000 }, () => {
  it('GETs /api/players/search with the username query param and auth headers', { timeout: 2000 }, async () => {
    const spy = capturingFetch(200, { players: [] })
    await searchPlayersByUsername({ username: 'alice', sessionId: 'sess-1', playerId: 'p-1' }, spy)
    assert.equal(spy.calls.length, 1)
    const url = spy.calls[0].url
    assert.ok(url.startsWith('/api/players/search'), `expected search URL, got ${url}`)
    assert.ok(url.includes('username=alice'), `expected username query param, got ${url}`)
    const opts = spy.calls[0].opts || {}
    assert.ok(!opts.method || opts.method === 'GET')
    assert.equal(opts.headers['x-session-id'], 'sess-1')
    assert.equal(opts.headers['x-player-id'], 'p-1')
  })

  it('URL-encodes the username to prevent injection', { timeout: 2000 }, async () => {
    const spy = capturingFetch(200, { players: [] })
    await searchPlayersByUsername(
      { username: 'a b&c=d', sessionId: 's', playerId: 'p' },
      spy,
    )
    const url = spy.calls[0].url
    assert.ok(!url.includes('a b&c=d'), 'raw value must not appear unencoded')
    assert.ok(url.includes('username='), 'must still include username key')
  })

  it('resolves with the players array on 200', { timeout: 2000 }, async () => {
    const body = {
      players: [
        { playerId: 'p-1', username: 'alice' },
        { playerId: 'p-2', username: 'alicia' },
      ],
    }
    const result = await searchPlayersByUsername(
      { username: 'ali', sessionId: 's', playerId: 'p' },
      mockFetch(200, body),
    )
    assert.equal(result.players.length, 2)
    assert.equal(result.players[0].username, 'alice')
  })

  it('throws with status on 401', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        searchPlayersByUsername(
          { username: 'ali', sessionId: 's', playerId: 'p' },
          mockFetch(401, { error: 'Unauthorized.' }),
        ),
      (err) => {
        assert.equal(err.status, 401)
        return true
      },
    )
  })
})

describe('createInviteSession (duplicate tracker)', { timeout: 2000 }, () => {
  it('starts empty — hasInvited returns false for any playerId', { timeout: 2000 }, () => {
    const session = createInviteSession()
    assert.equal(session.hasInvited('p-1'), false)
    assert.equal(session.hasInvited('anything'), false)
  })

  it('records a playerId via markInvited and reports it on hasInvited', { timeout: 2000 }, () => {
    const session = createInviteSession()
    session.markInvited('p-1')
    assert.equal(session.hasInvited('p-1'), true)
    assert.equal(session.hasInvited('p-2'), false)
  })

  it('tracks multiple playerIds independently', { timeout: 2000 }, () => {
    const session = createInviteSession()
    session.markInvited('p-1')
    session.markInvited('p-2')
    assert.equal(session.hasInvited('p-1'), true)
    assert.equal(session.hasInvited('p-2'), true)
    assert.equal(session.hasInvited('p-3'), false)
  })

  it('is idempotent — marking the same player twice does not throw', { timeout: 2000 }, () => {
    const session = createInviteSession()
    session.markInvited('p-1')
    session.markInvited('p-1')
    assert.equal(session.hasInvited('p-1'), true)
  })

  it('two sessions are independent', { timeout: 2000 }, () => {
    const a = createInviteSession()
    const b = createInviteSession()
    a.markInvited('p-1')
    assert.equal(a.hasInvited('p-1'), true)
    assert.equal(b.hasInvited('p-1'), false)
  })
})

describe('isPlayerInvitable', { timeout: 2000 }, () => {
  it('returns true for a player who is neither seated nor already invited', { timeout: 2000 }, () => {
    const out = isPlayerInvitable({
      player: { playerId: 'p-1' },
      seatedPlayerIds: ['p-other'],
      invitedPlayerIds: ['p-other2'],
    })
    assert.equal(out, true)
  })

  it('returns false when the player is already seated at the table', { timeout: 2000 }, () => {
    const out = isPlayerInvitable({
      player: { playerId: 'p-1' },
      seatedPlayerIds: ['p-1', 'p-2'],
      invitedPlayerIds: [],
    })
    assert.equal(out, false)
  })

  it('returns false when the player has a pending invite in this session', { timeout: 2000 }, () => {
    const out = isPlayerInvitable({
      player: { playerId: 'p-1' },
      seatedPlayerIds: [],
      invitedPlayerIds: ['p-1'],
    })
    assert.equal(out, false)
  })

  it('handles missing seatedPlayerIds / invitedPlayerIds as empty', { timeout: 2000 }, () => {
    assert.equal(isPlayerInvitable({ player: { playerId: 'p-1' } }), true)
  })

  it('returns false when player has no playerId', { timeout: 2000 }, () => {
    assert.equal(
      isPlayerInvitable({ player: {}, seatedPlayerIds: [], invitedPlayerIds: [] }),
      false,
    )
  })
})

describe('inviteFeedbackMessage', { timeout: 2000 }, () => {
  it('returns a success message naming the invitee on success', { timeout: 2000 }, () => {
    const msg = inviteFeedbackMessage({ status: 'success', username: 'alice' })
    assert.match(msg, /alice/)
    assert.match(msg, /Invite sent/i)
  })

  it('returns a duplicate-specific message on 409', { timeout: 2000 }, () => {
    const msg = inviteFeedbackMessage({ status: 409, username: 'alice' })
    assert.match(msg, /alice/)
    assert.match(msg, /pending invite/i)
  })

  it('returns a generic failure message for other errors', { timeout: 2000 }, () => {
    const msg = inviteFeedbackMessage({ status: 500, username: 'alice' })
    assert.ok(typeof msg === 'string' && msg.length > 0)
    assert.doesNotMatch(msg, /pending invite/i)
  })

  it('returns a generic failure message when status is 403 or 404', { timeout: 2000 }, () => {
    const m403 = inviteFeedbackMessage({ status: 403, username: 'alice' })
    const m404 = inviteFeedbackMessage({ status: 404, username: 'alice' })
    assert.ok(typeof m403 === 'string' && m403.length > 0)
    assert.ok(typeof m404 === 'string' && m404.length > 0)
    assert.doesNotMatch(m403, /pending invite/i)
    assert.doesNotMatch(m404, /pending invite/i)
  })
})

describe('invitePanelHtml', { timeout: 2000 }, () => {
  it('renders a container with a recognizable invite-panel class', { timeout: 2000 }, () => {
    const html = invitePanelHtml({ friends: [], searchResults: [] })
    assert.ok(html.includes('invite-panel'))
  })

  it('renders a row per friend with an Invite button', { timeout: 2000 }, () => {
    const html = invitePanelHtml({
      friends: [
        { playerId: 'p-1', username: 'alice', presenceStatus: 'online' },
        { playerId: 'p-2', username: 'bob', presenceStatus: 'offline' },
      ],
      searchResults: [],
    })
    assert.ok(html.includes('alice'))
    assert.ok(html.includes('bob'))
    const inviteMatches = html.match(/invite-btn/g) || []
    assert.ok(inviteMatches.length >= 2, 'expected an invite button per friend')
  })

  it('renders a search input for the username search', { timeout: 2000 }, () => {
    const html = invitePanelHtml({ friends: [], searchResults: [] })
    assert.ok(/input[^>]+invite-search/i.test(html) || html.includes('invite-search'), 'should include an invite-search input')
  })

  it('renders search results as rows with Invite buttons', { timeout: 2000 }, () => {
    const html = invitePanelHtml({
      friends: [],
      searchResults: [
        { playerId: 'p-3', username: 'carol' },
      ],
    })
    assert.ok(html.includes('carol'))
    assert.ok(html.includes('invite-btn'))
  })

  it('disables the invite button for players already seated at the table', { timeout: 2000 }, () => {
    const html = invitePanelHtml({
      friends: [{ playerId: 'p-1', username: 'alice', presenceStatus: 'online' }],
      searchResults: [],
      seatedPlayerIds: ['p-1'],
    })
    const row = extractRowFor(html, 'p-1')
    assert.ok(row, 'should render a row for p-1')
    assert.ok(/disabled/i.test(row), 'invite button for seated player should be disabled')
  })

  it('disables the invite button for players already invited in this session', { timeout: 2000 }, () => {
    const html = invitePanelHtml({
      friends: [{ playerId: 'p-1', username: 'alice', presenceStatus: 'online' }],
      searchResults: [],
      invitedPlayerIds: ['p-1'],
    })
    const row = extractRowFor(html, 'p-1')
    assert.ok(row, 'should render a row for p-1')
    assert.ok(/disabled/i.test(row), 'invite button for already-invited player should be disabled')
  })

  it('does not disable the invite button for a fresh, non-seated player', { timeout: 2000 }, () => {
    const html = invitePanelHtml({
      friends: [{ playerId: 'p-1', username: 'alice', presenceStatus: 'online' }],
      searchResults: [],
      seatedPlayerIds: ['p-other'],
      invitedPlayerIds: ['p-also-other'],
    })
    const row = extractRowFor(html, 'p-1')
    assert.ok(row)
    assert.ok(!/disabled/i.test(row), 'invite button should not be disabled for a fresh player')
  })

  it('escapes HTML in usernames returned by search', { timeout: 2000 }, () => {
    const html = invitePanelHtml({
      friends: [],
      searchResults: [{ playerId: 'p-x', username: '<script>alert(1)</script>' }],
    })
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must be escaped')
    assert.ok(html.includes('&lt;script&gt;'))
  })

  it('renders an empty-state for friends when no friends exist', { timeout: 2000 }, () => {
    const html = invitePanelHtml({ friends: [], searchResults: [] })
    assert.ok(/no friends/i.test(html))
  })
})

/**
 * Helper: pull out the DOM substring for a single player's row by data-player-id.
 * Works with either `data-player-id="X"` (friends panel convention) or
 * any `<button ... data-player-id="X" ...>invite...</button>` pattern.
 */
function extractRowFor(html, playerId) {
  const rowRe = new RegExp(
    `<[^>]*data-player-id="${playerId}"[\\s\\S]*?</(?:div|li|tr|button)>`,
    'i',
  )
  const m = html.match(rowRe)
  if (m) return m[0]
  const btnRe = new RegExp(
    `<button[^>]*data-player-id="${playerId}"[^>]*>[\\s\\S]*?</button>`,
    'i',
  )
  const m2 = html.match(btnRe)
  return m2 ? m2[0] : null
}
