/**
 * TDD tests for friend search UI clarity (Issue #708).
 *
 * Issue #708: Users cannot tell whether the search button on the friends
 * tab is for finding new players to add or for filtering existing friends.
 *
 * These tests verify that the search UI clearly communicates its purpose —
 * searching for *new players* to send friend requests to — through
 * unambiguous labels, placeholder text, and section headings.
 *
 * Tests target the pure HTML-generating helpers in infoPanel.js so they
 * can run without a DOM environment.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  addFriendSearchHtml,
  tabContentHtml,
  infoPanelHtml,
} from '../../../client/web/src/infoPanel.js'

/* ------------------------------------------------------------------ */
/*  addFriendSearchHtml — label clarity                                */
/* ------------------------------------------------------------------ */

describe('addFriendSearchHtml search UI clarity', { timeout: 2000 }, () => {
  it('uses placeholder text that indicates searching for new players', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml()
    // The placeholder should mention adding or finding players, not just "Search username"
    // which is ambiguous about whether it filters the existing friends list.
    assert.match(
      html,
      /placeholder="[^"]*[Aa]dd[^"]*"|placeholder="[^"]*[Ff]ind[^"]*[Pp]layer[^"]*"|placeholder="[^"]*new[^"]*"/i,
      'placeholder should clarify that search is for finding new players to add',
    )
  })

  it('search button text indicates adding rather than generic search', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml()
    // The button text should not just say "Search" — it should say something
    // like "Find Players", "Search Players", or "Add" to disambiguate.
    const buttonMatch = html.match(/<button[^>]*class="[^"]*friend-search-btn[^"]*"[^>]*>(.*?)<\/button>/)
    assert.ok(buttonMatch, 'should render the search button')
    const buttonText = buttonMatch[1]
    // Button text should reference players or finding, not just "Search"
    assert.ok(
      /[Ff]ind|[Pp]layer|[Aa]dd/i.test(buttonText),
      `button text "${buttonText}" should indicate this searches for players to add`,
    )
  })

  it('includes a visible section heading that distinguishes from friends list', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml()
    // There should be a heading or label element that says something like
    // "Add Friends" or "Find Players" to separate this from the friends list.
    assert.ok(
      /[Aa]dd\s+[Ff]riend|[Ff]ind\s+[Pp]layer|[Ss]earch\s+[Pp]layer/i.test(html),
      'should include a heading or label clarifying this section is for adding new friends',
    )
  })

  it('does not use ambiguous standalone "Search" as button label', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml()
    const buttonMatch = html.match(/<button[^>]*class="[^"]*friend-search-btn[^"]*"[^>]*>(.*?)<\/button>/)
    assert.ok(buttonMatch, 'should render the search button')
    const buttonText = buttonMatch[1].trim()
    assert.notEqual(
      buttonText,
      'Search',
      'button should not use bare "Search" which is ambiguous per issue #708',
    )
  })
})

/* ------------------------------------------------------------------ */
/*  addFriendSearchHtml — results labeling                             */
/* ------------------------------------------------------------------ */

describe('addFriendSearchHtml results clarity', { timeout: 2000 }, () => {
  it('shows results under a label that indicates these are other players', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({
      searchResults: [
        { playerId: 'p-1', username: 'alice' },
        { playerId: 'p-2', username: 'bob' },
      ],
    })
    // Results section should have context indicating these are search matches
    assert.ok(html.includes('alice'), 'should contain result username')
    assert.ok(html.includes('bob'), 'should contain result username')
    assert.ok(html.includes('add-friend-btn'), 'should have add-friend buttons')
  })

  it('preserves search query in input after rendering results', { timeout: 2000 }, () => {
    const html = addFriendSearchHtml({
      searchQuery: 'ali',
      searchResults: [{ playerId: 'p-1', username: 'alice' }],
    })
    assert.ok(
      html.includes('value="ali"'),
      'should preserve the search query in the input field',
    )
  })
})

/* ------------------------------------------------------------------ */
/*  tabContentHtml — search section placement and labeling             */
/* ------------------------------------------------------------------ */

describe('tabContentHtml friends tab search clarity', { timeout: 2000 }, () => {
  it('renders the add-friend search section on the friends tab', { timeout: 2000 }, () => {
    const html = tabContentHtml({ activeTab: 'friends', friends: [] })
    assert.ok(
      html.includes('add-friend-search') || html.includes('friend-search-btn'),
      'friends tab should contain the search section',
    )
  })

  it('renders search section with disambiguating text even when friends exist', { timeout: 2000 }, () => {
    const friends = [
      { playerId: 'p1', username: 'charlie', presenceStatus: 'online', tableInfo: null },
    ]
    const html = tabContentHtml({ activeTab: 'friends', friends })
    // Both the friends list and the search section should be present
    assert.ok(html.includes('charlie'), 'should show existing friend')
    assert.ok(
      html.includes('friend-search-btn'),
      'should include the search section alongside the friends list',
    )
    // Search button should not just say "Search"
    const buttonMatch = html.match(/<button[^>]*class="[^"]*friend-search-btn[^"]*"[^>]*>(.*?)<\/button>/)
    assert.ok(buttonMatch, 'search button should be rendered')
    assert.notEqual(
      buttonMatch[1].trim(),
      'Search',
      'search button text should not be bare "Search" when friends are displayed alongside',
    )
  })

  it('does not render search section on the history tab', { timeout: 2000 }, () => {
    const html = tabContentHtml({ activeTab: 'history' })
    assert.ok(
      !html.includes('friend-search-btn'),
      'history tab should not contain friend search',
    )
  })
})

/* ------------------------------------------------------------------ */
/*  infoPanelHtml — full panel search clarity                          */
/* ------------------------------------------------------------------ */

describe('infoPanelHtml search UI clarity', { timeout: 2000 }, () => {
  it('renders clarified search UI within the full panel', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    // The full panel should contain the search section with clear labeling
    const buttonMatch = html.match(/<button[^>]*class="[^"]*friend-search-btn[^"]*"[^>]*>(.*?)<\/button>/)
    assert.ok(buttonMatch, 'should render search button in full panel')
    assert.notEqual(
      buttonMatch[1].trim(),
      'Search',
      'full panel search button should not use ambiguous bare "Search"',
    )
  })

  it('search placeholder mentions finding or adding players in full panel', { timeout: 2000 }, () => {
    const html = infoPanelHtml({ activeTab: 'friends', friends: [], collapsed: false })
    assert.match(
      html,
      /placeholder="[^"]*[Aa]dd[^"]*"|placeholder="[^"]*[Ff]ind[^"]*"|placeholder="[^"]*new[^"]*"/i,
      'placeholder in full panel should clarify search purpose',
    )
  })
})
