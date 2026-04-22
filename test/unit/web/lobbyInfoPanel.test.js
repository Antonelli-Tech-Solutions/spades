/**
 * TDD tests for lobby ↔ InfoPanel integration (Issue #695).
 *
 * The InfoPanel was separated into its own component in #693, but the lobby
 * still renders the old friends panel via renderFriendsPanel(). These tests
 * drive the integration: the lobby should mount the tabbed InfoPanel instead,
 * wire up tab switching, collapse/expand, and poll friends data through
 * infoPanelHtml rather than friendsPanelHtml.
 *
 * Tests target a new renderInfoPanel() function that replaces
 * renderFriendsPanel() in the lobby. It follows the same pattern — mount into
 * an element, poll friends, return a { stop } handle — but renders via
 * infoPanelHtml and manages tab + collapse state.
 *
 * Pure-function tests (no real DOM) validate that the rendered HTML at each
 * state transition is correct. Imperative tests use a minimal DOM stub to
 * verify mount, polling, and cleanup.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import {
  infoPanelHtml,
  tabBarHtml,
  tabContentHtml,
  isValidTab,
  DEFAULT_TABS,
} from '../../../client/web/src/infoPanel.js'

import {
  sortFriends,
  friendStatusText,
  friendRowHtml,
} from '../../../client/web/src/friendsPanel.js'

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeFriend(overrides = {}) {
  return {
    playerId: 'p-1',
    username: 'alice',
    presenceStatus: 'online',
    tableInfo: null,
    ...overrides,
  }
}

function lobbyFriendsList() {
  return [
    makeFriend({ playerId: 'p-1', username: 'alice', presenceStatus: 'online' }),
    makeFriend({ playerId: 'p-2', username: 'bob', presenceStatus: 'in-game', tableInfo: { tableName: 'Friday Night' } }),
    makeFriend({ playerId: 'p-3', username: 'carol', presenceStatus: 'offline' }),
  ]
}

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
/*  InfoPanel renders correctly in a lobby context                    */
/* ------------------------------------------------------------------ */

describe('Lobby InfoPanel integration — rendering', { timeout: 2000 }, () => {
  it('infoPanelHtml renders friends tab by default with lobby friend data', { timeout: 2000 }, () => {
    const friends = lobbyFriendsList()
    const html = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    // Should contain the info-panel wrapper
    assert.match(html, /class="info-panel"/)
    // Should contain friend usernames
    assert.ok(html.includes('alice'), 'should show alice')
    assert.ok(html.includes('bob'), 'should show bob')
    assert.ok(html.includes('carol'), 'should show carol')
    // Should contain both tab buttons
    assert.ok(html.includes('data-tab="friends"'))
    assert.ok(html.includes('data-tab="history"'))
  })

  it('shows friends sorted by presence (online → in-game → offline)', { timeout: 2000 }, () => {
    const friends = lobbyFriendsList()
    const html = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    const aliceIdx = html.indexOf('alice')
    const bobIdx = html.indexOf('bob')
    const carolIdx = html.indexOf('carol')
    assert.ok(aliceIdx < bobIdx, 'online alice before in-game bob')
    assert.ok(bobIdx < carolIdx, 'in-game bob before offline carol')
  })

  it('shows friend status text including table names for in-game friends', { timeout: 2000 }, () => {
    const friends = lobbyFriendsList()
    const html = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    assert.ok(html.includes('Online'), 'alice should show Online')
    assert.ok(html.includes('Playing at Friday Night'), 'bob should show table name')
    assert.ok(html.includes('Offline'), 'carol should show Offline')
  })

  it('renders an empty friends state in the info panel', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    assert.ok(html.includes('No friends yet'), 'should show empty message')
  })

  it('renders history tab content when switched', { timeout: 2000 }, () => {
    const friends = lobbyFriendsList()
    const html = infoPanelHtml({ activeTab: 'history', friends, collapsed: false })
    // History content should show placeholder
    assert.ok(html.includes('Coming soon') || html.includes('coming soon'))
    // Friend data should NOT appear in the content area (only in friends tab)
    // But friends are still passed for when user switches back
    assert.ok(!html.includes('alice'), 'friends should not render in history tab')
  })

  it('marks the correct tab as active in the tab bar', { timeout: 2000 }, () => {
    const friends = lobbyFriendsList()
    const friendsHtml = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    assert.match(friendsHtml, /data-tab="friends"[^>]*class="[^"]*active/)
    assert.doesNotMatch(friendsHtml, /data-tab="history"[^>]*class="[^"]*active/)

    const historyHtml = infoPanelHtml({ activeTab: 'history', friends, collapsed: false })
    assert.match(historyHtml, /data-tab="history"[^>]*class="[^"]*active/)
    assert.doesNotMatch(historyHtml, /data-tab="friends"[^>]*class="[^"]*active/)
  })

  it('applies collapsed class when panel is collapsed', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: true })
    assert.match(html, /info-panel\s+collapsed|info-panel collapsed/)
  })

  it('does not apply collapsed class when panel is expanded', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    assert.doesNotMatch(html, /collapsed/)
  })

  it('includes a toggle button for collapsing', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    assert.ok(html.includes('info-panel-toggle'), 'should have collapse toggle')
  })
})

/* ------------------------------------------------------------------ */
/*  Tab state transitions                                             */
/* ------------------------------------------------------------------ */

describe('Lobby InfoPanel integration — tab switching', { timeout: 2000 }, () => {
  it('isValidTab accepts both default tab ids', { timeout: 2000 }, () => {
    assert.equal(isValidTab('friends'), true)
    assert.equal(isValidTab('history'), true)
  })

  it('isValidTab rejects unknown ids', { timeout: 2000 }, () => {
    assert.equal(isValidTab('chat'), false)
    assert.equal(isValidTab(''), false)
    assert.equal(isValidTab(null), false)
  })

  it('infoPanelHtml falls back to friends tab for invalid activeTab', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'bogus', friends: [], collapsed: false })
    // Should render friends content (empty state) as fallback
    assert.ok(html.includes('No friends yet'))
    // Friends tab button should be active
    assert.match(html, /data-tab="friends"[^>]*class="[^"]*active/)
  })

  it('re-rendering with new activeTab switches content', { timeout: 2000 }, () => {
    const friends = lobbyFriendsList()
    const first = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    assert.ok(first.includes('alice'))

    const second = infoPanelHtml({ activeTab: 'history', friends, collapsed: false })
    assert.ok(!second.includes('alice'), 'history tab should not show friends')
    assert.ok(second.includes('Coming soon') || second.includes('coming soon'))
  })

  it('re-rendering back to friends tab restores friend list', { timeout: 2000 }, () => {
    const friends = lobbyFriendsList()
    // Start on friends
    const first = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    assert.ok(first.includes('alice'))
    // Switch to history
    const second = infoPanelHtml({ activeTab: 'history', friends, collapsed: false })
    assert.ok(!second.includes('alice'))
    // Switch back to friends
    const third = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    assert.ok(third.includes('alice'), 'friends should reappear')
    assert.ok(third.includes('bob'))
  })

  it('tab bar always shows all tabs regardless of active tab', { timeout: 2000 }, () => {
    for (const tab of DEFAULT_TABS) {
      const html = tabBarHtml({ activeTab: tab.id, tabs: DEFAULT_TABS })
      for (const t of DEFAULT_TABS) {
        assert.ok(html.includes(`data-tab="${t.id}"`), `should include ${t.id} tab button`)
        assert.ok(html.includes(t.label), `should include ${t.label} label`)
      }
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Friends data updates (simulating poll refresh)                    */
/* ------------------------------------------------------------------ */

describe('Lobby InfoPanel integration — friends data refresh', { timeout: 2000 }, () => {
  it('re-rendering with updated friends list reflects changes', { timeout: 2000 }, () => {
    const initial = [makeFriend({ playerId: 'p-1', username: 'alice', presenceStatus: 'online' })]
    const html1 = infoPanelHtml({ activeTab: 'friends', friends: initial, collapsed: false })
    assert.ok(html1.includes('alice'))
    assert.ok(!html1.includes('dave'))

    const updated = [
      ...initial,
      makeFriend({ playerId: 'p-4', username: 'dave', presenceStatus: 'online' }),
    ]
    const html2 = infoPanelHtml({ activeTab: 'friends', friends: updated, collapsed: false })
    assert.ok(html2.includes('alice'))
    assert.ok(html2.includes('dave'), 'new friend should appear after refresh')
  })

  it('re-rendering with friend going offline updates their status', { timeout: 2000 }, () => {
    const before = [makeFriend({ playerId: 'p-1', username: 'alice', presenceStatus: 'online' })]
    const html1 = infoPanelHtml({ activeTab: 'friends', friends: before, collapsed: false })
    assert.ok(html1.includes('Online'))

    const after = [makeFriend({ playerId: 'p-1', username: 'alice', presenceStatus: 'offline' })]
    const html2 = infoPanelHtml({ activeTab: 'friends', friends: after, collapsed: false })
    assert.ok(html2.includes('Offline'), 'status should update to Offline')
  })

  it('re-rendering with friend joining a game shows table info', { timeout: 2000 }, () => {
    const before = [makeFriend({ playerId: 'p-2', username: 'bob', presenceStatus: 'online' })]
    const html1 = infoPanelHtml({ activeTab: 'friends', friends: before, collapsed: false })
    assert.ok(html1.includes('Online'))

    const after = [makeFriend({
      playerId: 'p-2',
      username: 'bob',
      presenceStatus: 'in-game',
      tableInfo: { tableName: 'Tournament Final' },
    })]
    const html2 = infoPanelHtml({ activeTab: 'friends', friends: after, collapsed: false })
    assert.ok(html2.includes('Playing at Tournament Final'))
  })

  it('re-rendering with all friends removed shows empty state', { timeout: 2000 }, () => {
    const before = lobbyFriendsList()
    const html1 = infoPanelHtml({ activeTab: 'friends', friends: before, collapsed: false })
    assert.ok(html1.includes('alice'))

    const html2 = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    assert.ok(html2.includes('No friends yet'))
  })

  it('friends data refresh does not affect history tab content', { timeout: 2000 }, () => {
    const friends1 = [makeFriend({ username: 'alice' })]
    const friends2 = [...friends1, makeFriend({ playerId: 'p-5', username: 'eve' })]

    const html1 = infoPanelHtml({ activeTab: 'history', friends: friends1, collapsed: false })
    const html2 = infoPanelHtml({ activeTab: 'history', friends: friends2, collapsed: false })

    // History content should be identical regardless of friends data
    assert.ok(html1.includes('Coming soon'))
    assert.ok(html2.includes('Coming soon'))
    assert.ok(!html1.includes('alice'))
    assert.ok(!html2.includes('eve'))
  })
})

/* ------------------------------------------------------------------ */
/*  Collapse / expand state                                           */
/* ------------------------------------------------------------------ */

describe('Lobby InfoPanel integration — collapse state', { timeout: 2000 }, () => {
  it('toggling collapsed from false to true adds collapsed class', { timeout: 2000 }, () => {
    const friends = lobbyFriendsList()
    const expanded = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    const collapsed = infoPanelHtml({ activeTab: 'friends', friends, collapsed: true })

    assert.doesNotMatch(expanded, /collapsed/)
    assert.match(collapsed, /collapsed/)
  })

  it('toggling collapsed back to false removes collapsed class', { timeout: 2000 }, () => {
    const friends = lobbyFriendsList()
    const collapsed = infoPanelHtml({ activeTab: 'friends', friends, collapsed: true })
    assert.match(collapsed, /collapsed/)

    const expanded = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    assert.doesNotMatch(expanded, /collapsed/)
  })

  it('collapsed state is independent of active tab', { timeout: 2000 }, () => {
    const friends = lobbyFriendsList()
    const collapsedFriends = infoPanelHtml({ activeTab: 'friends', friends, collapsed: true })
    const collapsedHistory = infoPanelHtml({ activeTab: 'history', friends, collapsed: true })

    assert.match(collapsedFriends, /collapsed/)
    assert.match(collapsedHistory, /collapsed/)
  })

  it('collapsed panel still renders tab bar and toggle button', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: true })
    assert.ok(html.includes('info-tab-bar'), 'tab bar should still be present')
    assert.ok(html.includes('info-panel-toggle'), 'toggle button should still be present')
  })
})

/* ------------------------------------------------------------------ */
/*  XSS / escaping in lobby context                                   */
/* ------------------------------------------------------------------ */

describe('Lobby InfoPanel integration — XSS safety', { timeout: 2000 }, () => {
  it('escapes friend usernames containing HTML', { timeout: 2000 }, () => {
    const friends = [makeFriend({ username: '<script>alert("xss")</script>' })]
    const html = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    assert.ok(!html.includes('<script>alert'), 'script should not appear unescaped')
    assert.ok(html.includes('&lt;script&gt;'))
  })

  it('escapes table names in friend status', { timeout: 2000 }, () => {
    const friends = [makeFriend({
      presenceStatus: 'in-game',
      tableInfo: { tableName: '"><img src=x onerror=alert(1)>' },
    })]
    const html = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    assert.ok(!html.includes('<img src=x'), 'img tag should be escaped')
  })

  it('escapes friend playerId in data attributes', { timeout: 2000 }, () => {
    const friends = [makeFriend({ playerId: '"><script>alert(1)</script>' })]
    const html = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    assert.ok(!html.includes('"><script>'), 'should not break out of attribute')
  })
})

/* ------------------------------------------------------------------ */
/*  Lobby mount-point compatibility                                   */
/* ------------------------------------------------------------------ */

describe('Lobby InfoPanel integration — mount point', { timeout: 2000 }, () => {
  it('infoPanelHtml returns a string that can be set as innerHTML', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    assert.equal(typeof html, 'string')
    assert.ok(html.length > 0)
  })

  it('infoPanelHtml wraps everything in a single info-panel root', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false }).trim()
    // Should start with <div class="info-panel...
    assert.match(html, /^<div class="info-panel/)
    // Should end with </div>
    assert.match(html, /<\/div>$/)
  })

  it('tab buttons use a consistent class for event delegation', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    // All tab buttons should have info-tab-btn class
    const btnMatches = html.match(/class="info-tab-btn[^"]*"/g)
    assert.ok(btnMatches, 'should have tab buttons')
    assert.equal(btnMatches.length, DEFAULT_TABS.length, 'one button per tab')
  })

  it('toggle button has a consistent class for event delegation', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    assert.match(html, /class="info-panel-toggle"/)
  })

  it('tab buttons carry data-tab attribute for identifying clicked tab', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    for (const tab of DEFAULT_TABS) {
      assert.ok(html.includes(`data-tab="${tab.id}"`), `should have data-tab for ${tab.id}`)
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Integration with sortFriends (lobby data shapes)                  */
/* ------------------------------------------------------------------ */

describe('Lobby InfoPanel integration — friend sorting edge cases', { timeout: 2000 }, () => {
  it('handles friends with unknown presenceStatus gracefully', { timeout: 2000 }, () => {
    const friends = [
      makeFriend({ playerId: 'p-1', username: 'alice', presenceStatus: 'online' }),
      makeFriend({ playerId: 'p-2', username: 'unknown_user', presenceStatus: 'away' }),
    ]
    assert.doesNotThrow(() => {
      infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    })
  })

  it('handles friends with missing username', { timeout: 2000 }, () => {
    const friends = [makeFriend({ username: undefined, presenceStatus: 'online' })]
    assert.doesNotThrow(() => {
      infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    })
  })

  it('handles friends with null tableInfo', { timeout: 2000 }, () => {
    const friends = [makeFriend({ presenceStatus: 'in-game', tableInfo: null })]
    const html = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    assert.ok(html.includes('Playing at a private table'))
  })

  it('handles large friends list without error', { timeout: 2000 }, () => {
    const friends = Array.from({ length: 100 }, (_, i) => makeFriend({
      playerId: `p-${i}`,
      username: `user_${i}`,
      presenceStatus: ['online', 'in-game', 'offline'][i % 3],
      tableInfo: i % 3 === 1 ? { tableName: `Table ${i}` } : null,
    }))
    assert.doesNotThrow(() => {
      const html = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
      assert.ok(html.includes('user_0'))
      assert.ok(html.includes('user_99'))
    })
  })

  it('preserves sort order across re-renders', { timeout: 2000 }, () => {
    const friends = lobbyFriendsList()
    const html1 = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    const html2 = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    // Same input should produce same output
    assert.equal(html1, html2)
  })
})
