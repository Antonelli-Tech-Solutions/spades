import { navigate } from './router.js'
import { getActiveTable } from './api.js'

/**
 * Check whether the authenticated player is currently seated at an active table.
 * If so, redirect to that table's game screen and return true.
 * Returns false if the player has no active table or if the check fails.
 *
 * Callers should return early when this returns true, since navigation has
 * already been triggered.
 *
 * @param {string} sessionId
 * @param {string} playerId
 * @returns {Promise<boolean>}
 */
export async function redirectIfSeated(sessionId, playerId) {
  try {
    const { tableId } = await getActiveTable({ sessionId, playerId })
    if (tableId) {
      navigate(`#/table?tableId=${tableId}`)
      return true
    }
  } catch (err) {
    // Unauthorised — auth guard will handle it; silently ignore other errors
    if (err.status === 401) return false
  }
  return false
}
