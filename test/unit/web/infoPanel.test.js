import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * TDD tests for the InfoPanel component — a collapsible, tabbed side panel
 * that hosts the Friends list (and later, Game History).
 *
 * Issue #693: The friends list should be separated from the lobby screen into
 * a standalone panel viewable on all screens, with a tab bar.
 *
 * These tests target the pure helper functions that will live in
 * client/web/src/infoPanel.js. They are written first (TDD) so the
 * implementation can be driven by them.
 */

// The module under test — will be created during implementation.
import {
  infoPanelHtml,
  tabBarHtml,
  tabContentHtml,
  DEFAULT_TABS,
  isValidTab,
} from '../../../client/web/src/infoPanel.js'

/* ------------------------------------------------------------------ */
/*  DEFAULT_TABS                                                      */
/* ------------------------------------------------------------------ */

describe('DEFAULT_TABS', { timeout: 2000 }, () => {
  it('contains a "friends" tab', { timeout: 2000 }, () => {
    const tab = DEFAULT_TABS.find((t) => t.id === 'friends')
    assert.ok(tab, 'friends tab should exist')
    assert.equal(tab.label, 'Friends')
  })

  it('contains a "history" tab', { timeout: 2000 }, () => {
    const tab = DEFAULT_TABS.find((t) => t.id === 'history')
    assert.ok(tab, 'history tab should exist')
    assert.equal(tab.label, 'Game History')
  })

  it('has friends as the first tab', { timeout: 2000 }, () => {
    assert.equal(DEFAULT_TABS[0].id, 'friends')
  })

  it('has exactly two tabs for the initial implementation', { timeout: 2000 }, () => {
    assert.equal(DEFAULT_TABS.length, 2)
  })
})

/* ------------------------------------------------------------------ */
/*  isValidTab                                                        */
/* ------------------------------------------------------------------ */

describe('isValidTab', { timeout: 2000 }, () => {
  it('returns true for "friends"', { timeout: 2000 }, () => {
    assert.equal(isValidTab('friends'), true)
  })

  it('returns true for "history"', { timeout: 2000 }, () => {
    assert.equal(isValidTab('history'), true)
  })

  it('returns false for an unknown tab id', { timeout: 2000 }, () => {
    assert.equal(isValidTab('settings'), false)
  })

  it('returns false for empty string', { timeout: 2000 }, () => {
    assert.equal(isValidTab(''), false)
  })

  it('returns false for null/undefined', { timeout: 2000 }, () => {
    assert.equal(isValidTab(null), false)
    assert.equal(isValidTab(undefined), false)
  })
})

/* ------------------------------------------------------------------ */
/*  tabBarHtml                                                        */
/* ------------------------------------------------------------------ */

describe('tabBarHtml', { timeout: 2000 }, () => {
  it('renders a button for each tab', { timeout: 2000 }, () => {
    const html = tabBarHtml({ activeTab: 'friends', tabs: DEFAULT_TABS })
    assert.ok(html.includes('Friends'), 'should contain Friends label')
    assert.ok(html.includes('Game History'), 'should contain Game History label')
  })

  it('marks the active tab with an active class', { timeout: 2000 }, () => {
    const html = tabBarHtml({ activeTab: 'friends', tabs: DEFAULT_TABS })
    // The active tab button should have an active indicator
    assert.match(html, /data-tab="friends"[^>]*class="[^"]*active/)
  })

  it('does not mark inactive tabs as active', { timeout: 2000 }, () => {
    const html = tabBarHtml({ activeTab: 'friends', tabs: DEFAULT_TABS })
    // The history tab button should NOT have the active class
    assert.doesNotMatch(html, /data-tab="history"[^>]*class="[^"]*active/)
  })

  it('switches active class when a different tab is active', { timeout: 2000 }, () => {
    const html = tabBarHtml({ activeTab: 'history', tabs: DEFAULT_TABS })
    assert.match(html, /data-tab="history"[^>]*class="[^"]*active/)
    assert.doesNotMatch(html, /data-tab="friends"[^>]*class="[^"]*active/)
  })

  it('includes data-tab attribute on each button for event delegation', { timeout: 2000 }, () => {
    const html = tabBarHtml({ activeTab: 'friends', tabs: DEFAULT_TABS })
    assert.ok(html.includes('data-tab="friends"'))
    assert.ok(html.includes('data-tab="history"'))
  })

  it('escapes HTML in tab labels', { timeout: 2000 }, () => {
    const customTabs = [{ id: 'xss', label: '<script>alert(1)</script>' }]
    const html = tabBarHtml({ activeTab: 'xss', tabs: customTabs })
    assert.ok(!html.includes('<script>alert(1)</script>'), 'script tag should be escaped')
    assert.ok(html.includes('&lt;script&gt;'))
  })
})

/* ------------------------------------------------------------------ */
/*  tabContentHtml                                                    */
/* ------------------------------------------------------------------ */

describe('tabContentHtml', { timeout: 2000 }, () => {
  it('renders friends content when activeTab is "friends"', { timeout: 2000 }, () => {
    const friends = [
      { playerId: 'p1', username: 'alice', presenceStatus: 'online', tableInfo: null },
    ]
    const html = tabContentHtml({ activeTab: 'friends', friends })
    assert.ok(html.includes('alice'), 'should show friend username')
    assert.ok(html.includes('friends-list') || html.includes('friends-panel'),
      'should contain friends list markup')
  })

  it('renders empty friends state when friends array is empty', { timeout: 2000 }, () => {
    const html = tabContentHtml({ activeTab: 'friends', friends: [] })
    assert.ok(html.includes('No friends yet'), 'should show empty message')
  })

  it('renders game history placeholder when activeTab is "history"', { timeout: 2000 }, () => {
    const html = tabContentHtml({ activeTab: 'history', friends: [] })
    assert.ok(html.includes('history'), 'should contain history section')
    assert.ok(
      html.includes('Coming soon') || html.includes('No game history') || html.includes('coming soon'),
      'should show placeholder for unimplemented history tab',
    )
  })

  it('renders friends content with multiple friends sorted correctly', { timeout: 2000 }, () => {
    const friends = [
      { playerId: 'p1', username: 'charlie', presenceStatus: 'offline', tableInfo: null },
      { playerId: 'p2', username: 'alice', presenceStatus: 'online', tableInfo: null },
      { playerId: 'p3', username: 'bob', presenceStatus: 'in-game', tableInfo: { tableName: 'Table1' } },
    ]
    const html = tabContentHtml({ activeTab: 'friends', friends })
    const aliceIdx = html.indexOf('alice')
    const bobIdx = html.indexOf('bob')
    const charlieIdx = html.indexOf('charlie')
    assert.ok(aliceIdx < bobIdx, 'online alice should appear before in-game bob')
    assert.ok(bobIdx < charlieIdx, 'in-game bob should appear before offline charlie')
  })

  it('escapes HTML in friend usernames', { timeout: 2000 }, () => {
    const friends = [
      { playerId: 'p1', username: '<img onerror=alert(1)>', presenceStatus: 'online', tableInfo: null },
    ]
    const html = tabContentHtml({ activeTab: 'friends', friends })
    assert.ok(!html.includes('<img onerror'), 'XSS payload should be escaped')
  })

  it('handles missing friends array gracefully on friends tab', { timeout: 2000 }, () => {
    const html = tabContentHtml({ activeTab: 'friends' })
    assert.ok(html.includes('No friends yet') || html.includes('friends'),
      'should handle undefined friends')
  })
})

/* ------------------------------------------------------------------ */
/*  infoPanelHtml (full panel)                                        */
/* ------------------------------------------------------------------ */

describe('infoPanelHtml', { timeout: 2000 }, () => {
  it('renders the outer panel container with info-panel class', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    assert.ok(html.includes('info-panel'), 'should have info-panel class')
  })

  it('includes the tab bar and content area', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    assert.ok(html.includes('data-tab="friends"'), 'should contain tab bar buttons')
    assert.ok(html.includes('data-tab="history"'), 'should contain history tab button')
    assert.ok(html.includes('No friends yet'), 'should contain friends content')
  })

  it('adds collapsed class when collapsed is true', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: true })
    assert.match(html, /info-panel[^"]*collapsed/)
  })

  it('does not add collapsed class when collapsed is false', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    assert.doesNotMatch(html, /info-panel[^"]*collapsed/)
  })

  it('includes a collapse toggle button', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    assert.ok(
      html.includes('info-panel-toggle') || html.includes('panel-toggle'),
      'should have a toggle button for collapsing',
    )
  })

  it('renders history tab content when activeTab is history', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'history', friends: [], collapsed: false })
    // Tab bar should still show both tabs
    assert.ok(html.includes('data-tab="friends"'))
    assert.ok(html.includes('data-tab="history"'))
    // Content should be the history placeholder
    assert.ok(
      html.includes('Coming soon') || html.includes('No game history') || html.includes('coming soon'),
    )
  })

  it('defaults to friends tab when activeTab is invalid', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'nonexistent', friends: [], collapsed: false })
    // Should fall back to friends tab content
    assert.ok(html.includes('No friends yet'), 'should fall back to friends content')
  })

  it('renders friend data in the panel', { timeout: 2000 }, () => {
    const friends = [
      { playerId: 'p1', username: 'alice', presenceStatus: 'online', tableInfo: null },
    ]
    const html = infoPanelHtml({ activeTab: 'friends', friends, collapsed: false })
    assert.ok(html.includes('alice'))
    assert.ok(html.includes('Online'))
  })
})
