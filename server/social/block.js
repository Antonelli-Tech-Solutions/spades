import { isValidUuid } from './profile.js'

export async function blockPlayer(db, blockerId, blockedId) {
  if (!isValidUuid(blockedId)) {
    throw Object.assign(new Error('invalid playerId'), { code: 'VALIDATION_ERROR' })
  }
  if (blockerId === blockedId) {
    throw Object.assign(new Error('cannot block yourself'), { code: 'VALIDATION_ERROR' })
  }

  const playerCheck = await db.query(`SELECT id FROM players WHERE id = $1`, [blockedId])
  if (playerCheck.rows.length === 0) {
    throw Object.assign(new Error('player not found'), { code: 'NOT_FOUND' })
  }

  const client = await db.connect()
  try {
    await client.query('BEGIN')

    await client.query(
      `INSERT INTO player_blocks (blocker_id, blocked_id)
       VALUES ($1, $2)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [blockerId, blockedId],
    )

    // Remove friendship in either direction
    await client.query(
      `DELETE FROM friendships
       WHERE ((requester_id = $1 AND addressee_id = $2)
          OR  (requester_id = $2 AND addressee_id = $1))
         AND status = 'accepted'`,
      [blockerId, blockedId],
    )

    // Remove any pending friend requests in either direction
    await client.query(
      `DELETE FROM friendships
       WHERE ((requester_id = $1 AND addressee_id = $2)
          OR  (requester_id = $2 AND addressee_id = $1))
         AND status = 'pending'`,
      [blockerId, blockedId],
    )

    await client.query('COMMIT')
    return { success: true }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function unblockPlayer(db, blockerId, blockedId) {
  if (!isValidUuid(blockedId)) {
    throw Object.assign(new Error('invalid playerId'), { code: 'VALIDATION_ERROR' })
  }

  const result = await db.query(
    `DELETE FROM player_blocks
     WHERE blocker_id = $1 AND blocked_id = $2
     RETURNING id`,
    [blockerId, blockedId],
  )

  if (result.rows.length === 0) {
    throw Object.assign(new Error('block not found'), { code: 'NOT_FOUND' })
  }

  return { success: true }
}

export async function getBlockList(db, playerId) {
  const result = await db.query(
    `SELECT b.blocked_id, p.username, b.created_at
     FROM player_blocks b
     JOIN players p ON p.id = b.blocked_id
     WHERE b.blocker_id = $1
     ORDER BY b.created_at DESC`,
    [playerId],
  )
  return result.rows.map((row) => ({
    playerId: row.blocked_id,
    username: row.username,
    blockedAt: row.created_at,
  }))
}

export async function isBlocked(db, blockerId, blockedId) {
  const result = await db.query(
    `SELECT 1 FROM player_blocks
     WHERE blocker_id = $1 AND blocked_id = $2
     LIMIT 1`,
    [blockerId, blockedId],
  )
  return result.rows.length > 0
}

export async function isBlockedEitherDirection(db, playerA, playerB) {
  const result = await db.query(
    `SELECT 1 FROM player_blocks
     WHERE (blocker_id = $1 AND blocked_id = $2)
        OR (blocker_id = $2 AND blocked_id = $1)
     LIMIT 1`,
    [playerA, playerB],
  )
  return result.rows.length > 0
}
