const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Return true if the given string is a valid UUID.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * Fetch usernames for a batch of player IDs from the database.
 * Returns a map of playerId → username. Missing IDs are omitted.
 *
 * @param {object} db - pg Pool (or compatible query interface)
 * @param {string[]} playerIds - Array of player UUID strings
 * @returns {Promise<Record<string, string>>}
 */
export async function getPlayerUsernames(db, playerIds) {
  if (playerIds.length === 0) return {}
  const result = await db.query(
    `SELECT id, username FROM players WHERE id = ANY($1::uuid[])`,
    [playerIds],
  )
  return Object.fromEntries(result.rows.map((row) => [row.id, row.username]))
}

/**
 * Fetch the public profile for a player.
 *
 * @param {object} db - pg Pool (or compatible query interface)
 * @param {string} playerId - UUID of the player
 * @returns {Promise<object>} Profile data
 */
export async function getPlayerProfile(db, playerId) {
  const playerResult = await db.query(
    `SELECT id, username FROM players WHERE id = $1`,
    [playerId],
  )
  if (playerResult.rows.length === 0) {
    throw Object.assign(new Error('player not found'), { code: 'NOT_FOUND' })
  }
  const player = playerResult.rows[0]

  const profileResult = await db.query(
    `SELECT avatar_icon, felt_color, card_back FROM player_profiles WHERE player_id = $1`,
    [playerId],
  )
  const profile = profileResult.rows[0] ?? {
    avatar_icon: 1,
    felt_color: 'green',
    card_back: 'standard-red',
  }

  const statsResult = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE won = TRUE)  AS wins,
       COUNT(*) FILTER (WHERE won = FALSE) AS losses
     FROM game_players
     WHERE player_id = $1`,
    [playerId],
  )
  const stats = statsResult.rows[0]

  const gamesResult = await db.query(
    `SELECT
       g.id           AS game_id,
       g.completed_at AS played_at,
       gp.won,
       g.score_ns,
       g.score_ew,
       gp.seat
     FROM game_players gp
     JOIN games g ON g.id = gp.game_id
     WHERE gp.player_id = $1
       AND g.completed_at IS NOT NULL
     ORDER BY g.completed_at DESC
     LIMIT 20`,
    [playerId],
  )

  return {
    playerId: player.id,
    username: player.username,
    avatar: { icon: profile.avatar_icon },
    cosmetics: {
      feltColor: profile.felt_color,
      cardBack: profile.card_back,
    },
    career: {
      wins: parseInt(stats.wins, 10),
      losses: parseInt(stats.losses, 10),
    },
    recentGames: gamesResult.rows.map((row) => ({
      gameId: row.game_id,
      playedAt: row.played_at,
      won: row.won,
      scoreNs: row.score_ns,
      scoreEw: row.score_ew,
      seat: row.seat,
    })),
  }
}
