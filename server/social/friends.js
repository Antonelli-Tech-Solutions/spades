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
       AND ((player_id = $1 AND friend_id = $2)
         OR (player_id = $2 AND friend_id = $1))
     LIMIT 1`,
    [playerA, playerB],
  )
  return result.rows.length > 0
}
