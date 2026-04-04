import { v4 as uuidv4 } from 'uuid'
import { hashPassword } from './registration.js'

const RESET_TOKEN_TTL_HOURS = 1

export function generateResetToken() {
  return uuidv4()
}

/**
 * Initiate a password reset for the given email address.
 *
 * Silently succeeds when the email is not found to prevent account enumeration.
 * Deletes any existing reset token for the player before issuing a new one.
 *
 * @param {object} db - pg Pool (or compatible query interface)
 * @param {string} email
 * @param {(email: string, token: string) => Promise<void>} sendPasswordResetEmail
 */
export async function forgotPassword(db, email, sendPasswordResetEmail) {
  const normalizedEmail = email.toLowerCase().trim()

  const result = await db.query(
    `SELECT id FROM players WHERE email = $1`,
    [normalizedEmail],
  )

  if (result.rows.length === 0) {
    return
  }

  const playerId = result.rows[0].id

  await db.query(`DELETE FROM password_reset_tokens WHERE player_id = $1`, [playerId])

  const token = generateResetToken()
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000)

  await db.query(
    `INSERT INTO password_reset_tokens (token, player_id, expires_at) VALUES ($1, $2, $3)`,
    [token, playerId, expiresAt],
  )

  await sendPasswordResetEmail(normalizedEmail, token)
}

/**
 * Reset the password for the player associated with the given reset token.
 *
 * @param {object} db - pg Pool (or compatible query interface)
 * @param {string} token
 * @param {string} newPassword
 * @returns {{ playerId: string }}
 */
export async function resetPassword(db, token, newPassword) {
  if (!token) {
    throw Object.assign(new Error('token is required'), { code: 'VALIDATION_ERROR' })
  }
  if (!newPassword || newPassword.length < 8) {
    throw Object.assign(new Error('password must be at least 8 characters'), {
      code: 'VALIDATION_ERROR',
    })
  }

  const result = await db.query(
    `SELECT player_id, expires_at FROM password_reset_tokens WHERE token = $1`,
    [token],
  )

  if (result.rows.length === 0) {
    throw Object.assign(new Error('invalid or already used reset token'), { code: 'INVALID_TOKEN' })
  }

  const { player_id, expires_at } = result.rows[0]

  if (new Date() > new Date(expires_at)) {
    throw Object.assign(new Error('reset token has expired'), { code: 'EXPIRED_TOKEN' })
  }

  const passwordHash = await hashPassword(newPassword)
  await db.query(`UPDATE players SET password_hash = $1 WHERE id = $2`, [passwordHash, player_id])
  await db.query(`DELETE FROM password_reset_tokens WHERE token = $1`, [token])

  return { playerId: player_id }
}
