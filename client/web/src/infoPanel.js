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

