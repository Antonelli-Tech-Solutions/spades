import { verifyPassword } from './registration.js'

/**
 * Validate login credentials against the database.
 *
 * @param {object} db - pg Pool
 * @param {{ email: string, password: string }} fields
 * @returns {Promise<{ playerId: string, email: string, username: string }>}
 */
export async function loginPlayer(db, { email, password }) {
  if (!email) {
    throw Object.assign(new Error('email is required'), { code: 'VALIDATION_ERROR' })
  }
  if (!password) {
    throw Object.assign(new Error('password is required'), { code: 'VALIDATION_ERROR' })
  }

  const normalizedEmail = email.toLowerCase().trim()

  const result = await db.query(
    `SELECT id, username, password_hash, is_verified FROM players WHERE email = $1`,
    [normalizedEmail],
  )

  if (result.rows.length === 0) {
    throw Object.assign(new Error('invalid email or password'), { code: 'INVALID_CREDENTIALS' })
  }

  const player = result.rows[0]

  if (!player.is_verified) {
    throw Object.assign(new Error('email address has not been verified'), {
      code: 'UNVERIFIED_EMAIL',
    })
  }

  const valid = await verifyPassword(password, player.password_hash)
  if (!valid) {
    throw Object.assign(new Error('invalid email or password'), { code: 'INVALID_CREDENTIALS' })
  }

  return { playerId: player.id, email: normalizedEmail, username: player.username }
}
