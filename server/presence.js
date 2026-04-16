/**
 * Redis presence state machine.
 *
 * Every player has a `presence:{playerId}` key tracking their current status:
 *   { status: 'online',  tableId: null }  — connected but not in a game
 *   { status: 'playing', tableId: <id> }  — seated at a table
 *
 * On WebSocket disconnect the key is deleted. A TTL is applied as a safety
 * net against stale keys (e.g. if a server crashes before cleanup).
 */

const PRESENCE_TTL_SECONDS = 3600

function presenceKey(playerId) {
  return `presence:${playerId}`
}

function isBot(playerId) {
  return typeof playerId === 'string' && playerId.startsWith('bot:')
}

/**
 * Set presence to `{ status: 'online', tableId: null }` with a TTL.
 * Bots are skipped — presence only tracks human players.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} playerId
 */
export async function setPresenceOnline(redis, playerId) {
  if (!redis || !playerId || isBot(playerId)) return
  try {
    const value = JSON.stringify({ status: 'online', tableId: null })
    await redis.set(presenceKey(playerId), value, { EX: PRESENCE_TTL_SECONDS })
  } catch (err) {
    console.error('Error setting presence online:', { playerId, error: err.message })
  }
}

/**
 * Set presence to `{ status: 'playing', tableId }` with a TTL.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} playerId
 * @param {string} tableId
 */
export async function setPresencePlaying(redis, playerId, tableId) {
  if (!redis || !playerId || isBot(playerId)) return
  try {
    const value = JSON.stringify({ status: 'playing', tableId })
    await redis.set(presenceKey(playerId), value, { EX: PRESENCE_TTL_SECONDS })
  } catch (err) {
    console.error('Error setting presence playing:', { playerId, tableId, error: err.message })
  }
}

/**
 * Remove the presence key. Called on WebSocket disconnect when the player has
 * no remaining connections.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} playerId
 */
export async function clearPresence(redis, playerId) {
  if (!redis || !playerId || isBot(playerId)) return
  try {
    await redis.del(presenceKey(playerId))
  } catch (err) {
    console.error('Error clearing presence:', { playerId, error: err.message })
  }
}
