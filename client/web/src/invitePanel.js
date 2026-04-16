/**
 * Waiting-room Invite panel — pure helpers + DOM-free renderer.
 *
 * The host-only Invite panel exposes two ways to send a table invite:
 *   1. From the friends list (fetched via /api/friends).
 *   2. From a username search (GET /api/players/search).
 *
 * Each helper here is independently testable. The renderer (invitePanelHtml)
 * returns an HTML string so it can be mounted by game.js into the waiting
 * room without coupling these helpers to a specific DOM library.
 */

const WAITING_STATUS = 'waiting'

/**
 * Should the Invite control be visible? Only when the local player is the
 * host AND the table is still in the waiting phase.
 * @param {{ isHost: boolean, status?: string }} args
 * @returns {boolean}
 */
export function shouldShowInviteControl({ isHost, status } = {}) {
  return Boolean(isHost) && status === WAITING_STATUS
}

/**
 * POST /api/tables/:tableId/invite — send a table invite to a target player.
 * @param {{ tableId: string, targetPlayerId: string, sessionId: string, playerId: string }} args
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<object>} response body
 */
export async function inviteTablePlayer(
  { tableId, targetPlayerId, sessionId, playerId },
  fetchFn = globalThis.fetch,
) {
  const res = await fetchFn(`/api/tables/${tableId}/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({ playerId: targetPlayerId }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to send invite.')
    err.status = res.status
    err.code = body.code
    throw err
  }
  return body
}

/**
 * GET /api/players/search?username=… — username search for invite picker.
 * @param {{ username: string, sessionId: string, playerId: string }} args
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ players: Array<{ playerId: string, username: string }> }>}
 */
export async function searchPlayersByUsername(
  { username, sessionId, playerId },
  fetchFn = globalThis.fetch,
) {
  const params = new URLSearchParams()
  params.set('username', username ?? '')
  const res = await fetchFn(`/api/players/search?${params.toString()}`, {
    method: 'GET',
    headers: {
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to search players.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Per-session duplicate-invite tracker. Prevents the host from spamming the
 * same player within a single waiting-room session even before the server
 * round-trip returns.
 * @returns {{ markInvited: (playerId: string) => void, hasInvited: (playerId: string) => boolean }}
 */
export function createInviteSession() {
  const invited = new Set()
  return {
    markInvited(playerId) {
      if (playerId) invited.add(playerId)
    },
    hasInvited(playerId) {
      return invited.has(playerId)
    },
  }
}

/**
 * Predicate: is this player a valid invite target right now? False if the
 * player is already seated at the table or has been invited in this session,
 * or if the player record is missing an id.
 * @param {{ player: object, seatedPlayerIds?: string[], invitedPlayerIds?: string[] }} args
 * @returns {boolean}
 */
export function isPlayerInvitable({ player, seatedPlayerIds = [], invitedPlayerIds = [] } = {}) {
  if (!player || !player.playerId) return false
  if (seatedPlayerIds.includes(player.playerId)) return false
  if (invitedPlayerIds.includes(player.playerId)) return false
  return true
}

/**
 * Build a user-facing feedback string for an invite attempt.
 * @param {{ status: 'success' | number, username: string }} args
 * @returns {string}
 */
export function inviteFeedbackMessage({ status, username }) {
  const name = username || 'player'
  if (status === 'success' || status === 200) {
    return `Invite sent to ${name}.`
  }
  if (status === 409) {
    return `${name} already has a pending invite.`
  }
  return `Could not send invite to ${name}. Please try again.`
}

/**
 * Render the invite panel body — friends list + search input + search results.
 * Pure: no DOM access, returns an HTML string.
 * @param {{
 *   friends?: Array<object>,
 *   searchResults?: Array<object>,
 *   seatedPlayerIds?: string[],
 *   invitedPlayerIds?: string[],
 * }} args
 * @returns {string}
 */
export function invitePanelHtml({
  friends = [],
  searchResults = [],
  seatedPlayerIds = [],
  invitedPlayerIds = [],
} = {}) {
  const friendsBody = friends.length === 0
    ? '<p class="invite-empty">No friends to invite.</p>'
    : friends.map((f) => inviteRowHtml(f, { seatedPlayerIds, invitedPlayerIds })).join('')

  const searchBody = searchResults.length === 0
    ? ''
    : `<div class="invite-search-results">${searchResults
      .map((p) => inviteRowHtml(p, { seatedPlayerIds, invitedPlayerIds }))
      .join('')}</div>`

  return `
    <div class="invite-panel">
      <h3 class="invite-panel-title">Invite players</h3>
      <div class="invite-friends">
        <h4 class="invite-section-title">Friends</h4>
        <div class="invite-friends-list">${friendsBody}</div>
      </div>
      <div class="invite-search">
        <label class="invite-search-label" for="invite-search-input">Search by username</label>
        <input
          id="invite-search-input"
          class="invite-search invite-search-input"
          type="text"
          placeholder="Search username…"
          autocomplete="off"
        />
        ${searchBody}
      </div>
    </div>
  `
}

function inviteRowHtml(player, { seatedPlayerIds, invitedPlayerIds }) {
  const playerId = player.playerId || ''
  const username = player.username || ''
  const status = player.presenceStatus
  const invitable = isPlayerInvitable({ player, seatedPlayerIds, invitedPlayerIds })
  const disabledAttr = invitable ? '' : 'disabled'
  const statusBadge = status
    ? `<span class="invite-row-status invite-row-status--${escapeHtml(status)}">${escapeHtml(status)}</span>`
    : ''
  return `
    <div class="invite-row" data-player-id="${escapeHtml(playerId)}">
      <span class="invite-row-username">${escapeHtml(username)}</span>
      ${statusBadge}
      <button
        type="button"
        class="invite-btn"
        data-player-id="${escapeHtml(playerId)}"
        ${disabledAttr}
      >Invite</button>
    </div>
  `
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
