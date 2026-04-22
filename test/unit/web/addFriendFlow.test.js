/**
 * TDD tests for the "Add Friend" flow in the InfoPanel's Friends tab.
 *
 * Issue #700: Add a search input, search results with "Add Friend" buttons,
 * and success/error feedback to the Friends tab in infoPanel.js.
 *
 * These tests target the pure helper functions that will be added to
 * client/web/src/infoPanel.js. They are written first (TDD) so the
 * implementation can be driven by them.
 *
 * The flow mirrors invitePanel.js's search pattern:
 *   - A search input + button
 *   - Results rendered with "Add Friend" buttons
 *   - Feedback messages after sending a request
 *   - Already-friends / self are not addable
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addFriendSearchHtml,
  addFriendFeedbackMessage,
  isAlreadyFriend,
  tabContentHtml,
} from '../../../client/web/src/infoPanel.js'

/* ------------------------------------------------------------------ */
/*  addFriendSearchHtml                                               */
/* ------------------------------------------------------------------ */

describe('addFriendSearchHtml', { timeout: 2000 }, () => {
  it('renders a search input field', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({ searchResults: [] })
    assert.ok(
      /input[^>]*friend-search/i.test(html) || html.includes('friend-search'),
      'should include a friend-search input',
    )
  })

  it('renders a search button', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({ searchResults: [] })
    assert.ok(
      html.includes('friend-search-btn') || /button[^>]*search/i.test(html),
      'should include a search button',
    )
  })

  it('renders search results with Add Friend buttons', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({
      searchResults: [
        { playerId: 'p-1', username: 'alice' },
        { playerId: 'p-2', username: 'bob' },
      ],
    })
    assert.ok(html.includes('alice'), 'should display alice')
    assert.ok(html.includes('bob'), 'should display bob')
    const addBtnMatches = html.match(/add-friend-btn/g) || []
    assert.ok(addBtnMatches.length >= 2, 'expected an Add Friend button per result')
  })

  it('includes data-player-id on each Add Friend button', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({
      searchResults: [{ playerId: 'p-42', username: 'carol' }],
    })
    assert.ok(
      html.includes('data-player-id="p-42"'),
      'Add Friend button should have data-player-id for event delegation',
    )
  })

  it('renders empty results area when no search results exist', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({ searchResults: [] })
    // Should not contain any add-friend-btn when there are no results
    assert.ok(
      !html.includes('add-friend-btn'),
      'should not render Add Friend buttons with no results',
    )
  })

  it('renders empty results area when searchResults is undefined', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({})
    assert.ok(typeof html === 'string', 'should return a string even with no searchResults')
    assert.ok(!html.includes('add-friend-btn'))
  })

  it('disables the Add Friend button for players who are already friends', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({
      searchResults: [{ playerId: 'p-1', username: 'alice' }],
      existingFriendIds: ['p-1'],
    })
    const row = extractRowFor(html, 'p-1')
    assert.ok(row, 'should render a row for p-1')
    assert.ok(/disabled/i.test(row), 'Add Friend button for existing friend should be disabled')
  })

  it('does not disable the Add Friend button for non-friends', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({
      searchResults: [{ playerId: 'p-1', username: 'alice' }],
      existingFriendIds: ['p-other'],
    })
    const row = extractRowFor(html, 'p-1')
    assert.ok(row, 'should render a row for p-1')
    assert.ok(!/disabled/i.test(row), 'Add Friend button should not be disabled for non-friends')
  })

  it('disables the Add Friend button for the current player (self)', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({
      searchResults: [{ playerId: 'p-me', username: 'myself' }],
      currentPlayerId: 'p-me',
    })
    const row = extractRowFor(html, 'p-me')
    assert.ok(row, 'should render a row for p-me')
    assert.ok(/disabled/i.test(row), 'Add Friend button should be disabled for self')
  })

  it('disables the Add Friend button for players with pending requests', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({
      searchResults: [{ playerId: 'p-1', username: 'alice' }],
      pendingRequestIds: ['p-1'],
    })
    const row = extractRowFor(html, 'p-1')
    assert.ok(row, 'should render a row for p-1')
    assert.ok(/disabled/i.test(row), 'Add Friend button should be disabled for pending request')
  })

  it('escapes HTML in usernames to prevent XSS', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({
      searchResults: [{ playerId: 'p-x', username: '<script>alert(1)</script>' }],
    })
    assert.ok(
      !html.includes('<script>alert(1)</script>'),
      'raw script tag must be escaped',
    )
    assert.ok(html.includes('&lt;script&gt;'))
  })

  it('renders feedback message when provided', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({
      searchResults: [],
      feedbackMessage: 'Friend request sent to alice!',
    })
    assert.ok(html.includes('Friend request sent to alice!'))
  })

  it('does not render feedback area when no feedbackMessage is set', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({ searchResults: [] })
    // Should not contain a non-empty feedback element
    assert.ok(
      !html.includes('Friend request sent') && !html.includes('Failed to send'),
      'no feedback text when feedbackMessage is not provided',
    )
  })
})

/* ------------------------------------------------------------------ */
/*  addFriendFeedbackMessage                                          */
/* ------------------------------------------------------------------ */

describe('addFriendFeedbackMessage', { timeout: 2000 }, () => {
  it('returns a success message naming the target user', { timeout: 2000 }, () => {
    const msg = addFriendFeedbackMessage({ status: 'success', username: 'alice' })
    assert.match(msg, /alice/)
    assert.match(msg, /friend request sent|request sent/i)
  })

  it('returns a duplicate-specific message on 409', { timeout: 2000 }, () => {
    const msg = addFriendFeedbackMessage({ status: 409, username: 'alice' })
    assert.match(msg, /alice/)
    assert.match(msg, /already|pending/i)
  })

  it('returns a generic failure message for 500', { timeout: 2000 }, () => {
    const msg = addFriendFeedbackMessage({ status: 500, username: 'alice' })
    assert.ok(typeof msg === 'string' && msg.length > 0)
    assert.doesNotMatch(msg, /already|pending/i)
  })

  it('returns a failure message for 404', { timeout: 2000 }, () => {
    const msg = addFriendFeedbackMessage({ status: 404, username: 'alice' })
    assert.ok(typeof msg === 'string' && msg.length > 0)
  })

  it('returns a failure message for 401', { timeout: 2000 }, () => {
    const msg = addFriendFeedbackMessage({ status: 401, username: 'alice' })
    assert.ok(typeof msg === 'string' && msg.length > 0)
  })

  it('handles missing username gracefully', { timeout: 2000 }, () => {
    const msg = addFriendFeedbackMessage({ status: 'success' })
    assert.ok(typeof msg === 'string' && msg.length > 0)
  })
})

/* ------------------------------------------------------------------ */
/*  isAlreadyFriend                                                   */
/* ------------------------------------------------------------------ */

describe('isAlreadyFriend', { timeout: 2000 }, () => {
  it('returns true when the player is in the existing friends list', { timeout: 2000 }, () => {
    assert.equal(
      isAlreadyFriend({ playerId: 'p-1', existingFriendIds: ['p-1', 'p-2'] }),
      true,
    )
  })

  it('returns false when the player is not in the friends list', { timeout: 2000 }, () => {
    assert.equal(
      isAlreadyFriend({ playerId: 'p-3', existingFriendIds: ['p-1', 'p-2'] }),
      false,
    )
  })

  it('returns false when existingFriendIds is empty', { timeout: 2000 }, () => {
    assert.equal(
      isAlreadyFriend({ playerId: 'p-1', existingFriendIds: [] }),
      false,
    )
  })

  it('handles missing existingFriendIds as empty', { timeout: 2000 }, () => {
    assert.equal(
      isAlreadyFriend({ playerId: 'p-1' }),
      false,
    )
  })

  it('returns false when playerId is null or undefined', { timeout: 2000 }, () => {
    assert.equal(isAlreadyFriend({ playerId: null, existingFriendIds: ['p-1'] }), false)
    assert.equal(isAlreadyFriend({ playerId: undefined, existingFriendIds: ['p-1'] }), false)
  })
})

/* ------------------------------------------------------------------ */
/*  tabContentHtml — friends tab now includes add-friend search       */
/* ------------------------------------------------------------------ */

describe('tabContentHtml with add-friend search', { timeout: 2000 }, () => {
  it('includes the add-friend search section in the friends tab', { timeout: 2000 }, () => {
    const html = tabContentHtml({ activeTab: 'friends', friends: [] })
    assert.ok(
      html.includes('friend-search') || html.includes('add-friend'),
      'friends tab should include the add-friend search area',
    )
  })

  it('does not include add-friend search in the history tab', { timeout: 2000 }, () => {
    const html = tabContentHtml({ activeTab: 'history', friends: [] })
    assert.ok(
      !html.includes('friend-search') && !html.includes('add-friend-btn'),
      'history tab should not include the add-friend search',
    )
  })

  it('still renders the friends list alongside the search area', { timeout: 2000 }, () => {
    const friends = [
      { playerId: 'p-1', username: 'alice', presenceStatus: 'online', tableInfo: null },
    ]
    const html = tabContentHtml({ activeTab: 'friends', friends })
    assert.ok(html.includes('alice'), 'should still render friends')
    assert.ok(
      html.includes('friend-search') || html.includes('add-friend'),
      'should also include search area',
    )
  })

  it('renders search results when provided', { timeout: 2000 }, () => {
    const html = tabContentHtml({
      activeTab: 'friends',
      friends: [],
      searchResults: [{ playerId: 'p-5', username: 'dave' }],
    })
    assert.ok(html.includes('dave'), 'should render search result username')
    assert.ok(html.includes('add-friend-btn'), 'should render Add Friend button')
  })

  it('renders feedback message when provided', { timeout: 2000 }, () => {
    const html = tabContentHtml({
      activeTab: 'friends',
      friends: [],
      feedbackMessage: 'Friend request sent to alice!',
    })
    assert.ok(html.includes('Friend request sent to alice!'))
  })
})

/* ------------------------------------------------------------------ */
/*  Helper                                                            */
/* ------------------------------------------------------------------ */

/**
 * Extract the DOM substring for a single player's row by data-player-id.
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
