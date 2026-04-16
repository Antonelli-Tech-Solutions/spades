import { isValidUuid } from './profile.js'

/**
 * Check whether two players are friends.
 *
 * @param {object} db - pg Pool
 * @param {string} playerA - UUID
 * @param {string} playerB - UUID
 * @returns {Promise<boolean>}
 */
export async function areFriends(db, playerA, playerB) {
  const result = await db.query(
    `SELECT 1 FROM friendships
     WHERE status = 'accepted'
       AND ((requester_id = $1 AND addressee_id = $2)
         OR (requester_id = $2 AND addressee_id = $1))
     LIMIT 1`,
    [playerA, playerB],
  )
  return result.rows.length > 0
}

/**
 * Search players by username prefix (case-insensitive).
 */
export async function searchPlayers(db, query, requesterId) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    throw Object.assign(new Error('username query is required'), { code: 'VALIDATION_ERROR' })
  }
  const trimmed = query.trim()
  if (trimmed.length > 50) {
    throw Object.assign(new Error('username query too long'), { code: 'VALIDATION_ERROR' })
  }
  const result = await db.query(
    `SELECT id, username FROM players
     WHERE LOWER(username) LIKE LOWER($1)
       AND id != $2
     ORDER BY username
     LIMIT 20`,
    [`${trimmed.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`, requesterId],
  )
  return result.rows.map((row) => ({ playerId: row.id, username: row.username }))
}

/**
 * Send a friend request from one player to another.
 */
export async function sendFriendRequest(db, fromPlayerId, toPlayerId) {
  if (!isValidUuid(toPlayerId)) {
    throw Object.assign(new Error('invalid playerId'), { code: 'VALIDATION_ERROR' })
  }
  if (fromPlayerId === toPlayerId) {
    throw Object.assign(new Error('cannot send friend request to yourself'), { code: 'VALIDATION_ERROR' })
  }

  const playerCheck = await db.query(`SELECT id FROM players WHERE id = $1`, [toPlayerId])
  if (playerCheck.rows.length === 0) {
    throw Object.assign(new Error('player not found'), { code: 'NOT_FOUND' })
  }

  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const existing = await client.query(
      `SELECT id, status, requester_id, addressee_id FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2)
          OR (requester_id = $2 AND addressee_id = $1)
       FOR UPDATE`,
      [fromPlayerId, toPlayerId],
    )

    if (existing.rows.length > 0) {
      const row = existing.rows[0]
      if (row.status === 'accepted') {
        throw Object.assign(new Error('already friends'), { code: 'DUPLICATE' })
      }
      if (row.status === 'pending') {
        if (row.requester_id === toPlayerId && row.addressee_id === fromPlayerId) {
          await client.query(`UPDATE friendships SET status = 'accepted', updated_at = NOW() WHERE id = $1`, [row.id])
          await client.query('COMMIT')
          return { success: true, autoAccepted: true }
        }
        throw Object.assign(new Error('friend request already pending'), { code: 'DUPLICATE' })
      }
    }

    await client.query(
      `INSERT INTO friendships (requester_id, addressee_id, status)
       VALUES ($1, $2, 'pending')`,
      [fromPlayerId, toPlayerId],
    )

    await client.query('COMMIT')
    return { success: true }
  } catch (err) {
    await client.query('ROLLBACK')
    if (err.code === '23505') {
      throw Object.assign(new Error('friend request already pending'), { code: 'DUPLICATE' })
    }
    throw err
  } finally {
    client.release()
  }
}

/**
 * Accept a pending friend request.
 */
export async function acceptFriendRequest(db, playerId, requesterId) {
  if (!isValidUuid(requesterId)) {
    throw Object.assign(new Error('invalid playerId'), { code: 'VALIDATION_ERROR' })
  }

  const result = await db.query(
    `UPDATE friendships SET status = 'accepted', updated_at = NOW()
     WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'
     RETURNING id`,
    [requesterId, playerId],
  )

  if (result.rows.length === 0) {
    throw Object.assign(new Error('no pending friend request found'), { code: 'NOT_FOUND' })
  }

  return { success: true }
}

/**
 * Decline a pending friend request.
 */
export async function declineFriendRequest(db, playerId, requesterId) {
  if (!isValidUuid(requesterId)) {
    throw Object.assign(new Error('invalid playerId'), { code: 'VALIDATION_ERROR' })
  }

  const result = await db.query(
    `DELETE FROM friendships
     WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'
     RETURNING id`,
    [requesterId, playerId],
  )

  if (result.rows.length === 0) {
    throw Object.assign(new Error('no pending friend request found'), { code: 'NOT_FOUND' })
  }

  return { success: true }
}

/**
 * Get the full friends list for a player (accepted friendships).
 *
 * When `redis` is supplied, each friend is enriched with:
 *   - `presenceStatus`: 'online' | 'in-game' | 'offline'
 *   - `tableInfo`: null when the friend is not in-game; otherwise an object
 *     `{ tableName }` where `tableName` is disclosed only when the requester
 *     is permitted to see the table name (public table, or friends-only table
 *     whose host is a friend of `requestingPlayerId`).
 *
 * @param {object} db - pg Pool
 * @param {string} playerId - the player whose friends list we're fetching
 * @param {{ redis?: import('redis').RedisClientType, requestingPlayerId?: string }} [options]
 */
export async function getFriends(db, playerId, { redis, requestingPlayerId } = {}) {
  const result = await db.query(
    `SELECT
       CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END AS friend_id,
       p.username,
       f.created_at
     FROM friendships f
     JOIN players p ON p.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
     WHERE (f.requester_id = $1 OR f.addressee_id = $1)
       AND f.status = 'accepted'
     ORDER BY p.username`,
    [playerId],
  )
  const friends = result.rows.map((row) => ({
    playerId: row.friend_id,
    username: row.username,
    since: row.created_at,
  }))

  if (!redis || friends.length === 0) return friends

  const requester = requestingPlayerId || playerId

  const presenceRaws = await Promise.all(
    friends.map((f) => redis.get(`presence:${f.playerId}`).catch(() => null)),
  )
  const presences = presenceRaws.map((raw) => {
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  })

  const tableIds = new Set()
  for (const p of presences) {
    if (p && p.status === 'playing' && p.tableId) tableIds.add(p.tableId)
  }

  const tableMap = new Map()
  await Promise.all(
    Array.from(tableIds).map(async (tableId) => {
      try {
        const raw = await redis.get(`table:${tableId}`)
        if (raw) tableMap.set(tableId, JSON.parse(raw))
      } catch (err) {
        console.error('Error loading table for friends enrichment:', { tableId, error: err.message })
      }
    }),
  )

  const hostFriendshipCache = new Map()
  async function isRequesterFriendOfHost(hostId) {
    if (!hostId) return false
    if (hostId === requester) return true
    if (hostFriendshipCache.has(hostId)) return hostFriendshipCache.get(hostId)
    const ok = await areFriends(db, requester, hostId)
    hostFriendshipCache.set(hostId, ok)
    return ok
  }

  const enriched = []
  for (let i = 0; i < friends.length; i++) {
    const friend = friends[i]
    const presence = presences[i]

    if (!presence) {
      enriched.push({ ...friend, presenceStatus: 'offline', tableInfo: null })
      continue
    }

    if (presence.status === 'online') {
      enriched.push({ ...friend, presenceStatus: 'online', tableInfo: null })
      continue
    }

    if (presence.status === 'playing') {
      const table = presence.tableId ? tableMap.get(presence.tableId) : null
      let tableName = null
      if (table) {
        if (table.visibility === 'public') {
          tableName = table.name ?? null
        } else if (table.visibility === 'friends-only') {
          // eslint-disable-next-line no-await-in-loop
          if (await isRequesterFriendOfHost(table.hostPlayerId)) {
            tableName = table.name ?? null
          }
        }
      }
      enriched.push({ ...friend, presenceStatus: 'in-game', tableInfo: { tableName } })
      continue
    }

    enriched.push({ ...friend, presenceStatus: 'offline', tableInfo: null })
  }

  return enriched
}

/**
 * Get pending friend requests received by a player.
 */
export async function getPendingRequests(db, playerId) {
  const result = await db.query(
    `SELECT f.requester_id, p.username, f.created_at
     FROM friendships f
     JOIN players p ON p.id = f.requester_id
     WHERE f.addressee_id = $1 AND f.status = 'pending'
     ORDER BY f.created_at DESC`,
    [playerId],
  )
  return result.rows.map((row) => ({
    playerId: row.requester_id,
    username: row.username,
    sentAt: row.created_at,
  }))
}

/**
 * Remove a friend (delete accepted friendship).
 */
export async function removeFriend(db, playerId, friendId) {
  if (!isValidUuid(friendId)) {
    throw Object.assign(new Error('invalid playerId'), { code: 'VALIDATION_ERROR' })
  }

  const result = await db.query(
    `DELETE FROM friendships
     WHERE ((requester_id = $1 AND addressee_id = $2)
        OR  (requester_id = $2 AND addressee_id = $1))
       AND status = 'accepted'
     RETURNING id`,
    [playerId, friendId],
  )

  if (result.rows.length === 0) {
    throw Object.assign(new Error('friendship not found'), { code: 'NOT_FOUND' })
  }

  return { success: true }
}
