import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  sortFriends,
  friendStatusText,
  friendsPanelHtml,
} from '../../../client/web/src/friendsPanel.js'
import { getFriends } from '../../../client/web/src/api.js'

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

describe('getFriends API', { timeout: 2000 }, () => {
  it('calls GET /api/friends with auth headers', { timeout: 2000 }, async () => {
    const spy = capturingFetch(200, { friends: [], pending: [] })
    await getFriends({ sessionId: 'sess-1', playerId: 'p-1' }, spy)
    assert.equal(spy.calls.length, 1)
    assert.equal(spy.calls[0].url, '/api/friends')
    const opts = spy.calls[0].opts || {}
    assert.ok(!opts.method || opts.method === 'GET')
    assert.equal(opts.headers['x-session-id'], 'sess-1')
    assert.equal(opts.headers['x-player-id'], 'p-1')
  })

  it('resolves with friends and pending arrays on 200', { timeout: 2000 }, async () => {
    const body = {
      friends: [{ playerId: 'f-1', username: 'alice', presenceStatus: 'online', tableInfo: null }],
      pending: [],
    }
    const result = await getFriends({ sessionId: 's', playerId: 'p' }, mockFetch(200, body))
    assert.equal(result.friends.length, 1)
    assert.equal(result.friends[0].username, 'alice')
  })

  it('throws with status on 401', { timeout: 2000 }, async () => {
    await assert.rejects(
      () => getFriends({ sessionId: 's', playerId: 'p' }, mockFetch(401, { error: 'Unauthorized.' })),
      (err) => { assert.equal(err.status, 401); return true },
    )
  })
})

describe('sortFriends', { timeout: 2000 }, () => {
  it('orders online → in-game → offline', { timeout: 2000 }, () => {
    const input = [
      { playerId: '1', username: 'c', presenceStatus: 'offline' },
      { playerId: '2', username: 'a', presenceStatus: 'in-game', tableInfo: { tableName: 'X' } },
      { playerId: '3', username: 'b', presenceStatus: 'online' },
    ]
    const out = sortFriends(input)
    assert.deepEqual(out.map((f) => f.presenceStatus), ['online', 'in-game', 'offline'])
  })

  it('breaks ties by username alphabetically', { timeout: 2000 }, () => {
    const input = [
      { playerId: '1', username: 'charlie', presenceStatus: 'online' },
      { playerId: '2', username: 'alice', presenceStatus: 'online' },
      { playerId: '3', username: 'bob', presenceStatus: 'online' },
    ]
    const out = sortFriends(input)
    assert.deepEqual(out.map((f) => f.username), ['alice', 'bob', 'charlie'])
  })

  it('does not mutate the original array', { timeout: 2000 }, () => {
    const input = [
      { playerId: '1', username: 'a', presenceStatus: 'offline' },
      { playerId: '2', username: 'b', presenceStatus: 'online' },
    ]
    const copy = [...input]
    sortFriends(input)
    assert.deepEqual(input, copy)
  })
})

describe('friendStatusText', { timeout: 2000 }, () => {
  it('returns "Online" when online', { timeout: 2000 }, () => {
    assert.equal(friendStatusText({ presenceStatus: 'online', tableInfo: null }), 'Online')
  })

  it('returns "Offline" when offline', { timeout: 2000 }, () => {
    assert.equal(friendStatusText({ presenceStatus: 'offline', tableInfo: null }), 'Offline')
  })

  it('returns "Playing at {tableName}" when in-game with tableName', { timeout: 2000 }, () => {
    const out = friendStatusText({ presenceStatus: 'in-game', tableInfo: { tableName: 'Friday Night' } })
    assert.equal(out, 'Playing at Friday Night')
  })

  it('returns "Playing at a private table" when in-game with null tableName', { timeout: 2000 }, () => {
    const out = friendStatusText({ presenceStatus: 'in-game', tableInfo: { tableName: null } })
    assert.equal(out, 'Playing at a private table')
  })

  it('returns "Playing at a private table" when in-game with no tableInfo', { timeout: 2000 }, () => {
    const out = friendStatusText({ presenceStatus: 'in-game', tableInfo: null })
    assert.equal(out, 'Playing at a private table')
  })
})

describe('friendsPanelHtml', { timeout: 2000 }, () => {
  it('renders an empty-state message when no friends', { timeout: 2000 }, () => {
    const html = friendsPanelHtml([])
    assert.ok(html.includes('friends-panel'))
    assert.ok(html.includes('No friends yet'))
  })

  it('renders a row per friend with status dot class', { timeout: 2000 }, () => {
    const friends = [
      { playerId: '1', username: 'alice', presenceStatus: 'online', tableInfo: null },
      { playerId: '2', username: 'bob', presenceStatus: 'in-game', tableInfo: { tableName: 'T1' } },
      { playerId: '3', username: 'carol', presenceStatus: 'offline', tableInfo: null },
    ]
    const html = friendsPanelHtml(friends)
    assert.ok(html.includes('alice'))
    assert.ok(html.includes('bob'))
    assert.ok(html.includes('carol'))
    assert.ok(html.includes('friend-dot--online'))
    assert.ok(html.includes('friend-dot--in-game'))
    assert.ok(html.includes('friend-dot--offline'))
    assert.ok(html.includes('Playing at T1'))
  })

  it('escapes HTML in usernames and table names', { timeout: 2000 }, () => {
    const html = friendsPanelHtml([
      { playerId: '1', username: '<script>', presenceStatus: 'in-game', tableInfo: { tableName: '<b>' } },
    ])
    assert.ok(!html.includes('<script>'), 'script tag should be escaped')
    assert.ok(html.includes('&lt;script&gt;'))
    assert.ok(html.includes('&lt;b&gt;'))
  })
})
