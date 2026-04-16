/**
 * In-app invite notification — pure helpers + DOM-free renderer.
 *
 * When the server publishes INVITE_RECEIVED on a player's notify channel, the
 * web client renders a stacking banner/overlay with Join + Decline actions.
 * This module exposes three pure pieces so they are independently testable:
 *
 *   - inviteNotificationHtml({ tableName, hostUsername, expiresAt })
 *       HTML-string renderer (no DOM access).
 *   - declineInvite({ inviteId, sessionId, playerId }, fetchFn)
 *       POST /api/invites/:inviteId/decline wrapper (mirrors the error-tagging
 *       pattern from invitePanel.js#inviteTablePlayer).
 *   - acceptInvite({ tableId, token })
 *       URL builder for the router-level navigation target. The existing join
 *       flow already honours the inviteToken query param via the joinlink:
 *       Redis key + invited-set path, bypassing invite-only policy.
 */

/**
 * Render the invite notification banner.
 * Pure — no DOM access, returns an HTML string.
 *
 * @param {{ tableName?: string, hostUsername?: string, expiresAt?: number|string }} [args]
 * @returns {string}
 */
export function inviteNotificationHtml({ tableName, hostUsername, expiresAt } = {}) {
  const safeHost = escapeHtml(hostUsername) || 'Someone'
  const safeTable = escapeHtml(tableName) || 'a table'
  const expiresAttr = expiresAt != null ? ` data-expires-at="${escapeHtml(String(expiresAt))}"` : ''
  return `
    <div class="invite-notification" role="alert" aria-live="polite"${expiresAttr}>
      <p class="invite-notification-message">
        <strong class="invite-notification-host">${safeHost}</strong>
        invited you to
        <strong class="invite-notification-table">${safeTable}</strong>
      </p>
      <div class="invite-notification-actions">
        <button type="button" class="btn-primary invite-notification-join">Join</button>
        <button type="button" class="btn-secondary invite-notification-decline">Decline</button>
      </div>
    </div>
  `
}

/**
 * POST /api/invites/:inviteId/decline — decline an in-app invite.
 * Throws an Error tagged with `.status` / `.code` on non-2xx.
 *
 * @param {{ inviteId: string, sessionId: string, playerId: string }} args
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<object>} response body (or `{}` on 204)
 */
export async function declineInvite(
  { inviteId, sessionId, playerId },
  fetchFn = globalThis.fetch,
) {
  const res = await fetchFn(`/api/invites/${encodeURIComponent(inviteId)}/decline`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
  })
  let body = {}
  try {
    body = await res.json()
  } catch {
    body = {}
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || 'Failed to decline invite.')
    err.status = res.status
    err.code = body && body.code
    throw err
  }
  return body
}

/**
 * Build the navigation target URL for accepting an invite. The router mounts
 * this via `navigate()` and the existing joinTable/game screens consume
 * `inviteToken` from the query string to bypass invite-only policy.
 *
 * @param {{ tableId: string, token: string }} args
 * @returns {string}
 */
export function acceptInvite({ tableId, token }) {
  const tid = encodeURIComponent(tableId ?? '')
  const tok = encodeURIComponent(token ?? '')
  return `#/table?tableId=${tid}&inviteToken=${tok}`
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
