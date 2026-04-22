import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * TDD tests for the Pending Requests section of the Friends tab.
 *
 * Issue #701: Add a "Pending Requests" section to the Friends tab in
 * infoPanel.js that shows incoming friend requests with Accept/Decline
 * buttons and a count badge.
 *
 * These tests target pure helper functions that will be added to
 * client/web/src/infoPanel.js. They are written first (TDD) so the
 * implementation can be driven by them.
 */

import {
  pendingRequestsHtml,
  pendingRequestBadgeHtml,
  tabContentHtml,
  infoPanelHtml,
} from '../../../client/web/src/infoPanel.js'

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const PENDING = [
  { playerId: 'req-1', username: 'alice' },
  { playerId: 'req-2', username: 'bob' },
  { playerId: 'req-3', username: 'charlie' },
]

/* ------------------------------------------------------------------ */
/*  pendingRequestsHtml                                                */
/* ------------------------------------------------------------------ */

describe('pendingRequestsHtml', { timeout: 2000 }, () => {
  it('returns empty string when pending array is empty', { timeout: 2000 }, () => {
    const html = pendingRequestsHtml([])
    assert.equal(html, '')
  })

  it('returns empty string when pending is undefined', { timeout: 2000 }, () => {
    const html = pendingRequestsHtml(undefined)
    assert.equal(html, '')
  })

  it('renders a section heading for pending requests', { timeout: 2000 }, () => {
    const html = pendingRequestsHtml(PENDING.slice(0, 1))
    assert.ok(html.includes('Pending Requests'), 'should show section heading')
  })

  it('renders one row per pending request', { timeout: 2000 }, () => {
    const html = pendingRequestsHtml(PENDING)
    assert.ok(html.includes('alice'))
    assert.ok(html.includes('bob'))
    assert.ok(html.includes('charlie'))
  })

  it('renders an Accept button for each request with data-player-id', { timeout: 2000 }, () => {
    const html = pendingRequestsHtml(PENDING.slice(0, 1))
    assert.match(html, /data-player-id="req-1"/)
    assert.match(html, /Accept/i)
  })

  it('renders a Decline button for each request with data-player-id', { timeout: 2000 }, () => {
    const html = pendingRequestsHtml(PENDING.slice(0, 1))
    assert.match(html, /Decline/i)
  })

  it('has distinct Accept and Decline buttons per request', { timeout: 2000 }, () => {
    const html = pendingRequestsHtml(PENDING.slice(0, 1))
    // Both buttons should reference the player id
    const acceptMatch = html.match(/accept-friend-btn/g) || html.match(/pending-accept/g)
    const declineMatch = html.match(/decline-friend-btn/g) || html.match(/pending-decline/g)
    assert.ok(acceptMatch, 'should have an accept button with identifiable class')
    assert.ok(declineMatch, 'should have a decline button with identifiable class')
  })

  it('renders multiple rows with correct player ids', { timeout: 2000 }, () => {
    const html = pendingRequestsHtml(PENDING)
    assert.ok(html.includes('data-player-id="req-1"'))
    assert.ok(html.includes('data-player-id="req-2"'))
    assert.ok(html.includes('data-player-id="req-3"'))
  })

  it('escapes HTML in usernames to prevent XSS', { timeout: 2000 }, () => {
    const malicious = [{ playerId: 'xss-1', username: '<script>alert("xss")</script>' }]
    const html = pendingRequestsHtml(malicious)
    assert.ok(!html.includes('<script>'), 'script tag should be escaped')
    assert.ok(html.includes('&lt;script&gt;'), 'should contain escaped tag')
  })

  it('escapes HTML in player ids', { timeout: 2000 }, () => {
    const malicious = [{ playerId: '"><img onerror=alert(1)>', username: 'eve' }]
    const html = pendingRequestsHtml(malicious)
    assert.ok(!html.includes('"><img'), 'player id injection should be escaped')
  })

  it('wraps requests in a pending-requests container', { timeout: 2000 }, () => {
    const html = pendingRequestsHtml(PENDING.slice(0, 1))
    assert.ok(html.includes('pending-requests'), 'should have pending-requests class')
  })
})

/* ------------------------------------------------------------------ */
/*  pendingRequestBadgeHtml                                            */
/* ------------------------------------------------------------------ */

describe('pendingRequestBadgeHtml', { timeout: 2000 }, () => {
  it('returns empty string when count is zero', { timeout: 2000 }, () => {
    const html = pendingRequestBadgeHtml(0)
    assert.equal(html, '')
  })

  it('returns empty string for undefined/null', { timeout: 2000 }, () => {
    assert.equal(pendingRequestBadgeHtml(undefined), '')
    assert.equal(pendingRequestBadgeHtml(null), '')
  })

  it('renders a badge with the count for one pending request', { timeout: 2000 }, () => {
    const html = pendingRequestBadgeHtml(1)
    assert.ok(html.includes('1'), 'should display count')
    assert.ok(html.includes('pending-badge') || html.includes('badge'),
      'should have a badge class')
  })

  it('renders the correct count for multiple pending requests', { timeout: 2000 }, () => {
    const html = pendingRequestBadgeHtml(5)
    assert.ok(html.includes('5'), 'should display count of 5')
  })

  it('renders badge as an inline element suitable for tab labels', { timeout: 2000 }, () => {
    const html = pendingRequestBadgeHtml(3)
    assert.match(html, /<span/, 'badge should be a span element')
  })
})

/* ------------------------------------------------------------------ */
/*  tabContentHtml — pending requests integration                      */
/* ------------------------------------------------------------------ */

describe('tabContentHtml with pending requests', { timeout: 2000 }, () => {
  it('includes pending requests section when pendingRequests is non-empty', { timeout: 2000 }, () => {
    const html = tabContentHtml({
      activeTab: 'friends',
      friends: [],
      pendingRequests: PENDING.slice(0, 1),
    })
    assert.ok(html.includes('Pending Requests'), 'should show pending section heading')
    assert.ok(html.includes('alice'), 'should show pending username')
  })

  it('does not show pending section when pendingRequests is empty', { timeout: 2000 }, () => {
    const html = tabContentHtml({
      activeTab: 'friends',
      friends: [],
      pendingRequests: [],
    })
    assert.ok(!html.includes('Pending Requests'),
      'should not show pending heading when no requests')
  })

  it('does not show pending section when pendingRequests is undefined', { timeout: 2000 }, () => {
    const html = tabContentHtml({
      activeTab: 'friends',
      friends: [],
    })
    assert.ok(!html.includes('Pending Requests'),
      'should not show pending heading when undefined')
  })

  it('renders both friends and pending requests together', { timeout: 2000 }, () => {
    const friends = [
      { playerId: 'f-1', username: 'dave', presenceStatus: 'online', tableInfo: null },
    ]
    const html = tabContentHtml({
      activeTab: 'friends',
      friends,
      pendingRequests: PENDING.slice(0, 1),
    })
    assert.ok(html.includes('dave'), 'should show existing friend')
    assert.ok(html.includes('alice'), 'should show pending request')
    assert.ok(html.includes('Accept'), 'should show accept button')
  })

  it('pending section appears before or alongside friends list', { timeout: 2000 }, () => {
    const friends = [
      { playerId: 'f-1', username: 'dave', presenceStatus: 'online', tableInfo: null },
    ]
    const html = tabContentHtml({
      activeTab: 'friends',
      friends,
      pendingRequests: PENDING.slice(0, 1),
    })
    const pendingIdx = html.indexOf('Pending Requests')
    const friendIdx = html.indexOf('dave')
    assert.ok(pendingIdx >= 0, 'pending section should exist')
    assert.ok(pendingIdx < friendIdx,
      'pending requests should appear before friends list')
  })

  it('does not render pending section on history tab', { timeout: 2000 }, () => {
    const html = tabContentHtml({
      activeTab: 'history',
      friends: [],
      pendingRequests: PENDING,
    })
    assert.ok(!html.includes('Pending Requests'),
      'history tab should not show pending requests')
    assert.ok(!html.includes('Accept'))
  })

  it('renders Accept and Decline buttons for each pending request', { timeout: 2000 }, () => {
    const html = tabContentHtml({
      activeTab: 'friends',
      friends: [],
      pendingRequests: PENDING,
    })
    // Each of the 3 pending requests should have accept/decline
    const acceptCount = (html.match(/Accept/gi) || []).length
    const declineCount = (html.match(/Decline/gi) || []).length
    assert.ok(acceptCount >= 3, `should have at least 3 accept buttons, got ${acceptCount}`)
    assert.ok(declineCount >= 3, `should have at least 3 decline buttons, got ${declineCount}`)
  })
})

/* ------------------------------------------------------------------ */
/*  infoPanelHtml — pending badge on tab                               */
/* ------------------------------------------------------------------ */

describe('infoPanelHtml with pending requests', { timeout: 2000 }, () => {
  it('shows a pending count badge on the Friends tab when requests exist', { timeout: 2000 }, () => {
    const html = infoPanelHtml({
      activeTab: 'friends',
      friends: [],
      pendingRequests: PENDING,
    })
    // Badge should show count near the Friends tab
    assert.ok(
      html.includes('3') || html.includes('badge'),
      'should display pending count badge',
    )
  })

  it('does not show a badge when there are no pending requests', { timeout: 2000 }, () => {
    const html = infoPanelHtml({
      activeTab: 'friends',
      friends: [],
      pendingRequests: [],
    })
    assert.ok(!html.includes('pending-badge') && !html.includes('badge'),
      'should not show badge with zero pending')
  })

  it('does not show badge when pendingRequests is undefined', { timeout: 2000 }, () => {
    const html = infoPanelHtml({
      activeTab: 'friends',
      friends: [],
    })
    assert.ok(!html.includes('pending-badge'),
      'should not show badge when pendingRequests is undefined')
  })

  it('includes pending requests in friends tab content', { timeout: 2000 }, () => {
    const html = infoPanelHtml({
      activeTab: 'friends',
      friends: [],
      pendingRequests: PENDING.slice(0, 2),
    })
    assert.ok(html.includes('alice'))
    assert.ok(html.includes('bob'))
    assert.ok(html.includes('Accept'))
    assert.ok(html.includes('Decline'))
  })
})
