/**
 * Friends panel — rendered on the lobby screen.
 *
 * Exposes pure helpers (sortFriends, friendsPanelHtml) plus renderFriendsPanel()
 * which handles fetching + polling + DOM updates. The pure helpers are unit-testable
 * without a DOM.
 */

import { getFriends } from './api.js'

const STATUS_ORDER = { online: 0, 'in-game': 1, offline: 2 }

/**
 * Sort friends by presence status (online → in-game → offline), then by username.
 * Returns a new array; does not mutate.
 * @param {Array<object>} friends
 * @returns {Array<object>}
 */
export function sortFriends(friends) {
  return [...friends].sort((a, b) => {
    const aOrder = STATUS_ORDER[a.presenceStatus] ?? 3
    const bOrder = STATUS_ORDER[b.presenceStatus] ?? 3
    if (aOrder !== bOrder) return aOrder - bOrder
    return String(a.username || '').localeCompare(String(b.username || ''))
  })
}

/**
 * Compute the status-line text for a friend.
 * @param {object} friend
 * @returns {string}
 */
export function friendStatusText(friend) {
  if (friend.presenceStatus === 'online') return 'Online'
  if (friend.presenceStatus === 'in-game') {
    const name = friend.tableInfo?.tableName
    return name ? `Playing at ${name}` : 'Playing at a private table'
  }
  return 'Offline'
}

/**
 * Render the HTML for the whole friends panel given a list of enriched friends.
 * @param {Array<object>} friends
 * @returns {string}
 */
export function friendsPanelHtml(friends) {
  const sorted = sortFriends(friends)
  const body = sorted.length === 0
    ? '<p class="friends-empty">No friends yet.</p>'
    : sorted.map(friendRowHtml).join('')
  return `
    <div class="friends-panel">
      <h2 class="lobby-tables-title">Friends</h2>
      <div id="friends-list" class="friends-list">${body}</div>
    </div>
  `
}

function friendRowHtml(friend) {
  const status = friend.presenceStatus || 'offline'
  const statusClass = `friend-dot friend-dot--${status === 'in-game' ? 'in-game' : status}`
  return `
    <div class="friend-row" data-player-id="${escapeHtml(friend.playerId)}">
      <span class="${statusClass}" aria-label="${escapeHtml(status)}"></span>
      <div class="friend-info">
        <span class="friend-username">${escapeHtml(friend.username || '')}</span>
        <span class="friend-status">${escapeHtml(friendStatusText(friend))}</span>
      </div>
    </div>
  `
}

/**
 * Mount the friends panel into a container and start polling.
 * Returns a handle with `stop()` to cancel polling.
 * @param {{
 *   mountEl: HTMLElement,
 *   sessionId: string,
 *   playerId: string,
 *   intervalMs?: number,
 *   fetchFn?: typeof fetch,
 * }} opts
 */
export function renderFriendsPanel({ mountEl, sessionId, playerId, intervalMs = 30000, fetchFn }) {
  let stopped = false
  let timer = null

  async function refresh() {
    if (stopped) return
    try {
      const { friends } = await getFriends({ sessionId, playerId }, fetchFn)
      if (stopped) return
      mountEl.innerHTML = friendsPanelHtml(friends || [])
    } catch (err) {
      console.log('Failed to load friends:', { error: err.message })
      if (stopped) return
      if (!mountEl.querySelector('.friends-panel')) {
        mountEl.innerHTML = `
          <div class="friends-panel">
            <h2 class="lobby-tables-title">Friends</h2>
            <p class="friends-empty">Could not load friends.</p>
          </div>
        `
      }
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

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

function escapeHtml(str) {
  return str
    ? String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
    : ''
}
