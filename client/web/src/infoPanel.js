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
    return `<button data-tab="${escapeHtml(tab.id)}" class="info-tab-btn${active}">${escapeHtml(tab.label)}</button>`
  }).join('')
  return `<div class="info-tab-bar">${buttons}</div>`
}

/**
 * Render the content area for the active tab.
 * @param {{ activeTab: string, friends?: Array<object> }} opts
 * @returns {string}
 */
export function tabContentHtml({ activeTab, friends }) {
  if (activeTab === 'history') {
    return `<div class="info-tab-content history-content"><p>Coming soon</p></div>`
  }
  // Default to friends tab
  const list = friends || []
  const sorted = sortFriends(list)
  const body = sorted.length === 0
    ? '<p class="friends-empty">No friends yet</p>'
    : sorted.map(friendRowHtml).join('')
  return `<div class="info-tab-content friends-list">${body}</div>`
}

/**
 * Render the full info panel (tab bar + content + toggle).
 * @param {{ activeTab: string, friends?: Array<object>, collapsed?: boolean }} opts
 * @returns {string}
 */
export function infoPanelHtml({ activeTab, friends = [], collapsed = false }) {
  const resolvedTab = isValidTab(activeTab) ? activeTab : 'friends'
  const collapseClass = collapsed ? ' collapsed' : ''
  const bar = tabBarHtml({ activeTab: resolvedTab, tabs: DEFAULT_TABS })
  const content = tabContentHtml({ activeTab: resolvedTab, friends })
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

