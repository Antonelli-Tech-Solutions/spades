import { v4 as uuidv4 } from 'uuid'

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

/**
 * Create a new session in Redis and return the session ID.
 * Stored under key `session:{sessionId}` with a 7-day TTL.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {{ playerId: string, email: string, username: string }} data
 * @returns {Promise<string>} sessionId
 */
export async function createSession(redis, { playerId, email, username }) {
  const sessionId = uuidv4()
  const key = `session:${sessionId}`
  const value = JSON.stringify({ playerId, email, username, createdAt: new Date().toISOString() })
  await redis.set(key, value, { EX: SESSION_TTL_SECONDS })
  console.log('Session created:', { sessionId, playerId })
  return sessionId
}

/**
 * Retrieve session data from Redis.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} sessionId
 * @returns {Promise<{ playerId: string, email: string, username: string, createdAt: string } | null>}
 */
export async function getSession(redis, sessionId) {
  if (!sessionId) return null
  const key = `session:${sessionId}`
  const raw = await redis.get(key)
  if (!raw) return null
  return JSON.parse(raw)
}

/**
 * Delete a session from Redis (logout).
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} sessionId
 */
export async function deleteSession(redis, sessionId) {
  if (!sessionId) return
  const key = `session:${sessionId}`
  await redis.del(key)
  console.log('Session deleted:', { sessionId })
}

/**
 * Validate x-session-id and x-player-id request headers against Redis.
 * Throws with code UNAUTHORIZED if validation fails.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {import('express').Request} req
 * @returns {Promise<{ playerId: string, email: string, username: string }>}
 */
export async function validateAuthHeaders(redis, req) {
  const sessionId = req.headers['x-session-id']
  const playerId = req.headers['x-player-id']

  if (!sessionId || !playerId) {
    throw Object.assign(new Error('missing auth headers'), { code: 'UNAUTHORIZED' })
  }

  const session = await getSession(redis, sessionId)
  if (!session) {
    throw Object.assign(new Error('invalid or expired session'), { code: 'UNAUTHORIZED' })
  }

  if (session.playerId !== playerId) {
    throw Object.assign(new Error('session player mismatch'), { code: 'UNAUTHORIZED' })
  }

  return session
}
