/**
 * Unit tests for the in-app invite notification UI helpers (Issue #685).
 *
 * These tests drive the creation of client/web/src/inviteNotification.js,
 * which should expose:
 *   - inviteNotificationHtml({ tableName, hostUsername, expiresAt })
 *       — DOM-free renderer for the banner/overlay shown when an
 *         INVITE_RECEIVED event arrives. Includes Join + Decline buttons.
 *   - declineInvite({ inviteId, sessionId, playerId }, fetchFn)
 *       — POST /api/invites/:inviteId/decline. Throws an Error tagged with
 *         .status / .code on non-2xx (mirrors invitePanel.js#inviteTablePlayer).
 *   - acceptInvite({ tableId, token })
 *       — pure URL builder returning the navigation target for the router,
 *         carrying the invite token in the query string.
 *
 * The server-side INVITE_RECEIVED publish + /decline endpoint are covered
 * by sub-issue 0's integration tests; here we mock fetch and exercise the
 * client contract only.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  inviteNotificationHtml,
  declineInvite,
  acceptInvite,
} from '../../../client/web/src/inviteNotification.js'

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

describe('inviteNotificationHtml', { timeout: 2000 }, () => {
  it('renders a container with a recognizable invite-notification class', { timeout: 2000 }, () => {
    const html = inviteNotificationHtml({
      tableName: 'Friday Night',
      hostUsername: 'alice',
      expiresAt: Date.now() + 60_000,
    })
    assert.ok(typeof html === 'string' && html.length > 0)
    assert.ok(/invite-notification/i.test(html), 'should include invite-notification class')
  })

  it('shows the host username and table name in the banner copy', { timeout: 2000 }, () => {
    const html = inviteNotificationHtml({
      tableName: 'Friday Night',
      hostUsername: 'alice',
      expiresAt: Date.now() + 60_000,
    })
    assert.ok(html.includes('alice'), 'banner should name the host')
    assert.ok(html.includes('Friday Night'), 'banner should name the table')
  })

  it('renders a Join button', { timeout: 2000 }, () => {
    const html = inviteNotificationHtml({
      tableName: 'T',
      hostUsername: 'alice',
      expiresAt: Date.now() + 60_000,
    })
    assert.ok(/<button[^>]*>[^<]*Join[^<]*<\/button>/i.test(html), 'should render a Join button')
  })

  it('renders a Decline button', { timeout: 2000 }, () => {
    const html = inviteNotificationHtml({
      tableName: 'T',
      hostUsername: 'alice',
      expiresAt: Date.now() + 60_000,
    })
    assert.ok(/<button[^>]*>[^<]*Decline[^<]*<\/button>/i.test(html), 'should render a Decline button')
  })

  it('escapes HTML in the host username to prevent XSS', { timeout: 2000 }, () => {
    const html = inviteNotificationHtml({
      tableName: 'Safe',
      hostUsername: '<script>alert(1)</script>',
      expiresAt: Date.now() + 60_000,
    })
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not appear unescaped')
    assert.ok(html.includes('&lt;script&gt;'), 'angle brackets must be HTML-escaped')
  })

  it('escapes HTML in the table name to prevent XSS', { timeout: 2000 }, () => {
    const html = inviteNotificationHtml({
      tableName: '<img src=x onerror=alert(1)>',
      hostUsername: 'alice',
      expiresAt: Date.now() + 60_000,
    })
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'raw img tag must be escaped')
    assert.ok(html.includes('&lt;img'), 'angle brackets must be HTML-escaped')
  })

  it('handles missing optional values without throwing', { timeout: 2000 }, () => {
    const html = inviteNotificationHtml({})
    assert.ok(typeof html === 'string' && html.length > 0)
    assert.ok(/invite-notification/i.test(html))
  })
})

describe('declineInvite API', { timeout: 2000 }, () => {
  it('POSTs to /api/invites/:inviteId/decline with auth headers', { timeout: 2000 }, async () => {
    const spy = capturingFetch(200, { ok: true })
    await declineInvite(
      { inviteId: 'inv-1', sessionId: 'sess-1', playerId: 'p-1' },
      spy,
    )
    assert.equal(spy.calls.length, 1)
    assert.equal(spy.calls[0].url, '/api/invites/inv-1/decline')
    const opts = spy.calls[0].opts || {}
    assert.equal(opts.method, 'POST')
    assert.equal(opts.headers['x-session-id'], 'sess-1')
    assert.equal(opts.headers['x-player-id'], 'p-1')
  })

  it('resolves with the response body on 200', { timeout: 2000 }, async () => {
    const result = await declineInvite(
      { inviteId: 'inv-1', sessionId: 's', playerId: 'p' },
      mockFetch(200, { message: 'Invite declined' }),
    )
    assert.equal(result.message, 'Invite declined')
  })

  it('also resolves on 204 (No Content) without throwing', { timeout: 2000 }, async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 204,
      json: async () => ({}),
    })
    await assert.doesNotReject(() =>
      declineInvite({ inviteId: 'inv-1', sessionId: 's', playerId: 'p' }, fetchFn),
    )
  })

  it('throws an error tagged with status 410 when the invite has already expired/used', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        declineInvite(
          { inviteId: 'inv-1', sessionId: 's', playerId: 'p' },
          mockFetch(410, { error: 'INVITE_GONE', code: 'INVITE_GONE' }),
        ),
      (err) => {
        assert.equal(err.status, 410)
        return true
      },
    )
  })

  it('throws with status 404 when the invite does not exist', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        declineInvite(
          { inviteId: 'missing', sessionId: 's', playerId: 'p' },
          mockFetch(404, { error: 'Invite not found' }),
        ),
      (err) => {
        assert.equal(err.status, 404)
        return true
      },
    )
  })

  it('throws with status 401 when the session is invalid', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        declineInvite(
          { inviteId: 'inv-1', sessionId: 'bad', playerId: 'p' },
          mockFetch(401, { error: 'Unauthorized' }),
        ),
      (err) => {
        assert.equal(err.status, 401)
        return true
      },
    )
  })

  it('throws with status 403 when the player is not the invitee', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        declineInvite(
          { inviteId: 'inv-1', sessionId: 's', playerId: 'p-wrong' },
          mockFetch(403, { error: 'Forbidden', code: 'NOT_INVITEE' }),
        ),
      (err) => {
        assert.equal(err.status, 403)
        return true
      },
    )
  })

  it('propagates a server-supplied error code on the thrown Error', { timeout: 2000 }, async () => {
    await assert.rejects(
      () =>
        declineInvite(
          { inviteId: 'inv-1', sessionId: 's', playerId: 'p' },
          mockFetch(410, { error: 'Invite gone', code: 'INVITE_GONE' }),
        ),
      (err) => {
        assert.equal(err.code, 'INVITE_GONE')
        return true
      },
    )
  })

  it('propagates network errors from the underlying fetch', { timeout: 2000 }, async () => {
    const boom = async () => {
      throw new Error('network down')
    }
    await assert.rejects(
      () => declineInvite({ inviteId: 'inv-1', sessionId: 's', playerId: 'p' }, boom),
      (err) => {
        assert.match(err.message, /network/i)
        return true
      },
    )
  })

  it('URL-encodes the inviteId path segment to prevent path injection', { timeout: 2000 }, async () => {
    const spy = capturingFetch(200, { ok: true })
    await declineInvite(
      { inviteId: 'a/b?c', sessionId: 's', playerId: 'p' },
      spy,
    )
    const url = spy.calls[0].url
    assert.ok(!url.includes('a/b?c'), 'raw inviteId must not appear unencoded in the URL')
    assert.ok(url.startsWith('/api/invites/'), 'should target the invites endpoint')
    assert.ok(url.endsWith('/decline'), 'should hit the /decline action')
  })
})

describe('acceptInvite (URL builder)', { timeout: 2000 }, () => {
  it('returns a string URL referencing the tableId', { timeout: 2000 }, () => {
    const url = acceptInvite({ tableId: 't-1', token: 'tok-abc' })
    assert.equal(typeof url, 'string')
    assert.ok(url.includes('t-1'), 'URL should reference the tableId')
  })

  it('includes the invite token in the query string under inviteToken=', { timeout: 2000 }, () => {
    const url = acceptInvite({ tableId: 't-1', token: 'tok-abc' })
    assert.ok(/[?&]inviteToken=tok-abc(?:&|$)/.test(url), `expected inviteToken=tok-abc in URL, got ${url}`)
  })

  it('points at the table/join screen so the existing join flow handles the token', { timeout: 2000 }, () => {
    const url = acceptInvite({ tableId: 't-1', token: 'tok-abc' })
    assert.ok(/table/i.test(url), `URL should target a table route, got ${url}`)
  })

  it('URL-encodes a token containing special characters', { timeout: 2000 }, () => {
    const url = acceptInvite({ tableId: 't-1', token: 'a b&c=d' })
    assert.ok(!url.includes('a b&c=d'), 'raw token with reserved chars must not appear unencoded')
    assert.ok(url.includes('inviteToken='), 'should still include inviteToken key')
  })

  it('URL-encodes a tableId containing special characters', { timeout: 2000 }, () => {
    const url = acceptInvite({ tableId: 'table id?x', token: 'tok' })
    assert.ok(!url.includes('table id?x'), 'raw tableId with reserved chars must not appear unencoded')
  })

  it('returns distinct URLs for distinct inputs', { timeout: 2000 }, () => {
    const a = acceptInvite({ tableId: 't-1', token: 'tok-1' })
    const b = acceptInvite({ tableId: 't-2', token: 'tok-2' })
    assert.notEqual(a, b)
  })
})
