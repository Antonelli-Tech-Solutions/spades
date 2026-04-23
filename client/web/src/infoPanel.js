/**
 * InfoPanel — a collapsible, tabbed side panel that hosts the Friends list
 * and Game History tabs. Viewable on all screens.
 *
 * Issue #693: Separate the friends list from the lobby into a standalone
 * panel with a tab bar.
 *
 * Exports pure helpers (infoPanelHtml, tabBarHtml, tabContentHtml, etc.)
 * that are unit-testable without a DOM.
 */

import { sortFriends, friendStatusText, friendRowHtml, escapeHtml } from './friendsPanel.js'
import { getFriends } from './api.js'
import { navigate } from './router.js'

/**
 * Render the pending friend requests section.
 * @param {Array<{playerId: string, username: string}>|undefined} pending
 * @returns {string}
 */
export function pendingRequestsHtml(pending) {
  if (!pending || pending.length === 0) return ''
  const rows = pending.map((req) => {
    const pid = escapeHtml(req.playerId || '')
    const uname = escapeHtml(req.username || '')
    return `<div class="pending-request-row" data-player-id="${pid}"><span class="pending-username">${uname}</span><button type="button" class="pending-accept accept-friend-btn" data-player-id="${pid}">Accept</button><button type="button" class="pending-decline decline-friend-btn" data-player-id="${pid}">Decline</button></div>`
  }).join('')
  return `<div class="pending-requests"><h3>Pending Requests</h3>${rows}</div>`
}

/**
 * Render a count badge for pending friend requests.
 * @param {number|undefined|null} count
 * @returns {string}
 */
export function pendingRequestBadgeHtml(count) {
  if (!count) return ''
  return `<span class="pending-badge">${count}</span>`
}

export const DEFAULT_TABS = [
  { id: 'friends', label: 'Friends' },
  { id: 'history', label: 'Game History' },
]

/**
 * Check whether a tab id is valid (exists in DEFAULT_TABS).
 * @param {string|null|undefined} tabId
 * @returns {boolean}
 */
export function isValidTab(tabId) {
  if (!tabId) return false
  return DEFAULT_TABS.some((t) => t.id === tabId)
}

/**
 * Render the tab bar HTML.
 * @param {{ activeTab: string, tabs?: Array<{id: string, label: string}> }} opts
 * @returns {string}
 */
export function tabBarHtml({ activeTab, tabs = DEFAULT_TABS }) {
  const buttons = tabs.map((tab) => {
    const active = tab.id === activeTab ? ' active' : ''
    const badge = tab.badgeHtml || ''
    return `<button data-tab="${escapeHtml(tab.id)}" class="info-tab-btn${active}">${escapeHtml(tab.label)}${badge}</button>`
  }).join('')
  return `<div class="info-tab-bar">${buttons}</div>`
}

/**
 * Check whether a player is already in the friends list.
 * @param {{ playerId: string|null|undefined, existingFriendIds?: string[] }} opts
 * @returns {boolean}
 */
export function isAlreadyFriend({ playerId, existingFriendIds } = {}) {
  if (!playerId) return false
  const ids = existingFriendIds || []
  return ids.includes(playerId)
}

/**
 * Build a user-facing feedback string for an add-friend attempt.
 * @param {{ status: 'success' | number, username?: string }} opts
 * @returns {string}
 */
export function addFriendFeedbackMessage({ status, username } = {}) {
  const name = username || 'player'
  if (status === 'success') {
    return `Friend request sent to ${name}!`
  }
  if (status === 409) {
    return `${name} already has a pending request.`
  }
  return `Could not send friend request to ${name}. Please try again.`
}

/**
 * Render the add-friend search section HTML (input + button + results + feedback).
 * @param {{
 *   searchResults?: Array<{ playerId: string, username: string }>,
 *   existingFriendIds?: string[],
 *   currentPlayerId?: string,
 *   pendingRequestIds?: string[],
 *   feedbackMessage?: string,
 * }} opts
 * @returns {string}
 */
export function addFriendSearchHtml({
  searchResults,
  searchQuery,
  existingFriendIds = [],
  currentPlayerId,
  pendingRequestIds = [],
  feedbackMessage,
} = {}) {
  const results = searchResults || []
  const resultsBody = results.map((p) => {
    const pid = p.playerId || ''
    const uname = escapeHtml(p.username || '')
    const isFriend = isAlreadyFriend({ playerId: pid, existingFriendIds })
    const isSelf = currentPlayerId && pid === currentPlayerId
    const isPending = pendingRequestIds.includes(pid)
    const disabledAttr = (isFriend || isSelf || isPending) ? ' disabled' : ''
    return `<div class="add-friend-row" data-player-id="${escapeHtml(pid)}"><span class="add-friend-username">${uname}</span><button type="button" class="add-friend-btn" data-player-id="${escapeHtml(pid)}"${disabledAttr}>Add Friend</button></div>`
  }).join('')

  const feedbackHtml = feedbackMessage
    ? `<div class="add-friend-feedback">${escapeHtml(feedbackMessage)}</div>`
    : ''

  const valueAttr = searchQuery ? ` value="${escapeHtml(searchQuery)}"` : ''

  return `<div class="add-friend-search"><h3 class="add-friend-heading">Add Friend</h3><input type="text" class="friend-search-input" id="friend-search" placeholder="Find new players to add…" autocomplete="off"${valueAttr} /><button type="button" class="friend-search-btn">Find Players</button>${feedbackHtml}<div class="add-friend-results">${resultsBody}</div></div>`
}

/**
 * Render the content area for the active tab.
 * @param {{ activeTab: string, friends?: Array<object>, searchResults?: Array<object>, existingFriendIds?: string[], currentPlayerId?: string, pendingRequestIds?: string[], feedbackMessage?: string }} opts
 * @returns {string}
 */
export function tabContentHtml({ activeTab, friends, searchResults, existingFriendIds, currentPlayerId, pendingRequestIds, feedbackMessage, pendingRequests }) {
  if (activeTab === 'history') {
    return `<div class="info-tab-content history-content"><p>Coming soon</p></div>`
  }
  // Default to friends tab
  const list = friends || []
  const sorted = sortFriends(list)
  const body = sorted.length === 0
    ? '<p class="friends-empty">No friends yet</p>'
    : sorted.map(friendRowHtml).join('')
  const searchSection = addFriendSearchHtml({ searchResults, existingFriendIds, currentPlayerId, pendingRequestIds, feedbackMessage })
  const pendingSection = pendingRequestsHtml(pendingRequests)
  return `<div class="info-tab-content friends-list">${searchSection}${pendingSection}${body}</div>`
}

/**
 * Render the full info panel (tab bar + content + toggle).
 * @param {{ activeTab: string, friends?: Array<object>, collapsed?: boolean }} opts
 * @returns {string}
 */
export function infoPanelHtml({ activeTab, friends = [], collapsed = false, pendingRequests }) {
  const resolvedTab = isValidTab(activeTab) ? activeTab : 'friends'
  const collapseClass = collapsed ? ' collapsed' : ''
  const pendingCount = (pendingRequests && pendingRequests.length) || 0
  const tabsWithBadge = DEFAULT_TABS.map((tab) => {
    if (tab.id === 'friends' && pendingCount > 0) {
      return { ...tab, badgeHtml: pendingRequestBadgeHtml(pendingCount) }
    }
    return tab
  })
  const bar = tabBarHtml({ activeTab: resolvedTab, tabs: tabsWithBadge })
  const content = tabContentHtml({ activeTab: resolvedTab, friends, pendingRequests })
  return `<div class="info-panel${collapseClass}"><button class="info-panel-toggle" aria-label="Toggle panel"></button>${bar}${content}</div>`
}

/**
 * Mount the tabbed InfoPanel into a container and start polling friends.
 * Replaces renderFriendsPanel() in the lobby — renders via infoPanelHtml
 * and manages tab + collapse state.
 *
 * Returns a handle with `stop()` to cancel polling.
 * @param {{
 *   mountEl: HTMLElement,
 *   sessionId: string,
 *   playerId: string,
 *   intervalMs?: number,
 *   fetchFn?: typeof fetch,
 * }} opts
 */
export function renderInfoPanel({ mountEl, sessionId, playerId, intervalMs = 30000, fetchFn }) {
  let stopped = false
  let timer = null
  let activeTab = 'friends'
  let collapsed = false
  let friends = []

  function stop() {
    stopped = true
    if (timer) clearTimeout(timer)
  }

  function render() {
    mountEl.innerHTML = infoPanelHtml({ activeTab, friends, collapsed })

    // Wire tab switching via event delegation
    mountEl.querySelectorAll('.info-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab
        if (isValidTab(tab)) {
          activeTab = tab
          render()
        }
      })
    })

    // Wire collapse toggle
    const toggleBtn = mountEl.querySelector('.info-panel-toggle')
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        collapsed = !collapsed
        render()
      })
    }
  }

  async function refresh() {
    if (stopped) return
    try {
      const result = await getFriends({ sessionId, playerId }, fetchFn)
      if (stopped) return
      friends = result.friends || []
      render()
    } catch (err) {
      console.log('Failed to load friends:', { error: err.message })
      if (stopped) return
      if (err.status === 401) {
        stop()
        navigate('#/login')
        return
      }
      // On error, render with whatever friends we already have
      render()
    }
  }

  function scheduleNext() {
    if (stopped) return
    timer = setTimeout(async () => {
      await refresh()
      scheduleNext()
    }, intervalMs)
  }

  refresh().then(scheduleNext)

  return { stop }
}

