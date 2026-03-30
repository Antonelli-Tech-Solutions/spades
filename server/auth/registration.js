import { v4 as uuidv4 } from 'uuid'
import bcrypt from 'bcryptjs'

const BCRYPT_ROUNDS = 12
const VERIFICATION_TOKEN_TTL_HOURS = 24

export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash)
}

export function generateVerificationToken() {
  return uuidv4()
}

/**
 * Register a new player.
 *
 * @param {object} db - pg Pool (or compatible query interface)
 * @param {{ email: string, username: string, password: string }} fields
 * @param {(email: string, token: string) => Promise<void>} sendVerificationEmail
 * @returns {{ playerId: string }}
 */
export async function registerPlayer(db, { email, username, password }, sendVerificationEmail) {
  if (!email) {
    throw Object.assign(new Error('email is required'), { code: 'VALIDATION_ERROR' })
  }
  if (!username) {
    throw Object.assign(new Error('username is required'), { code: 'VALIDATION_ERROR' })
  }
  if (!password) {
    throw Object.assign(new Error('password is required'), { code: 'VALIDATION_ERROR' })
  }
  if (password.length < 8) {
    throw Object.assign(new Error('password must be at least 8 characters'), {
      code: 'VALIDATION_ERROR',
    })
  }

  const normalizedEmail = email.toLowerCase().trim()
  const trimmedUsername = username.trim()
  const passwordHash = await hashPassword(password)

  let player
  try {
    const result = await db.query(
      `INSERT INTO players (email, username, password_hash, is_verified)
       VALUES ($1, $2, $3, FALSE)
       RETURNING id`,
      [normalizedEmail, trimmedUsername, passwordHash],
    )
    player = result.rows[0]
  } catch (err) {
    if (err.code === '23505') {
      // unique_violation
      if (err.constraint && err.constraint.includes('email')) {
        throw Object.assign(new Error('email already registered'), { code: 'DUPLICATE_EMAIL' })
      }
      if (err.constraint && err.constraint.includes('username')) {
        throw Object.assign(new Error('username already taken'), { code: 'DUPLICATE_USERNAME' })
      }
    }
    throw err
  }

  const token = generateVerificationToken()
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000)

  await db.query(
    `INSERT INTO email_verification_tokens (token, player_id, expires_at)
     VALUES ($1, $2, $3)`,
    [token, player.id, expiresAt],
  )

  await sendVerificationEmail(normalizedEmail, token)

  return { playerId: player.id }
}

/**
 * Verify an email verification token.
 * Marks the associated player as verified and deletes the token (single-use).
 *
 * @param {object} db - pg Pool (or compatible query interface)
 * @param {string} token
 * @returns {{ playerId: string }}
 */
export async function verifyEmailToken(db, token) {
  if (!token) {
    throw Object.assign(new Error('token is required'), { code: 'VALIDATION_ERROR' })
  }

  const result = await db.query(
    `SELECT player_id, expires_at FROM email_verification_tokens WHERE token = $1`,
    [token],
  )

  if (result.rows.length === 0) {
    throw Object.assign(new Error('invalid or already used verification token'), {
      code: 'INVALID_TOKEN',
    })
  }

  const { player_id, expires_at } = result.rows[0]

  if (new Date() > new Date(expires_at)) {
    throw Object.assign(new Error('verification token has expired'), { code: 'EXPIRED_TOKEN' })
  }

  await db.query(`UPDATE players SET is_verified = TRUE WHERE id = $1`, [player_id])
  await db.query(`DELETE FROM email_verification_tokens WHERE token = $1`, [token])

  return { playerId: player_id }
}

/**
 * Check whether a player has verified their email.
 *
 * @param {object} db
 * @param {string} playerId
 * @returns {Promise<boolean>}
 */
export async function isPlayerVerified(db, playerId) {
  const result = await db.query(`SELECT is_verified FROM players WHERE id = $1`, [playerId])
  if (result.rows.length === 0) return false
  return result.rows[0].is_verified
}
