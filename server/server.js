import { registerPlayer, verifyEmailToken } from './auth/registration.js'
import { sendVerificationEmail as defaultMailer } from './auth/email.js'
import { loginPlayer } from './auth/login.js'
import { createSession, deleteSession } from './auth/session.js'
import { getDb } from './db.js'
import { getRedis } from './redis.js'
import { createRateLimiter } from './middleware/rateLimiter.js'

function sendJSON(res, statusCode, data) {
  res.status(statusCode).json(data)
}

/**
 * Register all API route handlers on the given Express app.
 *
 * @param {import('express').Application} app
 * @param {{ mailer?: (email: string, token: string) => Promise<void>, redis?: object, rateLimitConfig?: { max?: number, windowSecs?: number } }} [opts]
 */
export function handler(app, { mailer, redis, rateLimitConfig } = {}) {
  const emailer = mailer ?? defaultMailer
  const authRateLimiter = createRateLimiter(redis ?? null, {
    keyPrefix: 'auth',
    ...rateLimitConfig,
  })

  // POST /api/auth/register
  app.post('/api/auth/register', authRateLimiter, async (req, res) => {
    const { email, username, password } = req.body ?? {}
    try {
      const db = getDb()
      const result = await registerPlayer(db, { email, username, password }, emailer)
      sendJSON(res, 201, {
        message: 'Registration successful. Please check your email to verify your account.',
        playerId: result.playerId,
      })
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'DUPLICATE_EMAIL') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'DUPLICATE_USERNAME') return sendJSON(res, 409, { error: err.message })
      console.error('Registration error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // GET /api/auth/verify-email?token=<uuid>
  app.get('/api/auth/verify-email', authRateLimiter, async (req, res) => {
    const { token } = req.query
    try {
      const db = getDb()
      await verifyEmailToken(db, token)
      sendJSON(res, 200, { message: 'Email verified successfully. You may now log in.' })
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'INVALID_TOKEN') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'EXPIRED_TOKEN') return sendJSON(res, 400, { error: err.message })
      console.error('Email verification error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/auth/login
  app.post('/api/auth/login', authRateLimiter, async (req, res) => {
    const { email, password } = req.body ?? {}
    try {
      const db = getDb()
      const redis = await getRedis()
      const playerData = await loginPlayer(db, { email, password })
      const sessionId = await createSession(redis, playerData)
      sendJSON(res, 200, {
        sessionId,
        playerId: playerData.playerId,
        username: playerData.username,
      })
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'INVALID_CREDENTIALS') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'UNVERIFIED_EMAIL') return sendJSON(res, 403, { error: err.message })
      console.error('Login error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/auth/logout
  app.post('/api/auth/logout', async (req, res) => {
    const sessionId = req.headers['x-session-id']
    try {
      const redis = await getRedis()
      await deleteSession(redis, sessionId)
      sendJSON(res, 200, { message: 'Logged out successfully.' })
    } catch (err) {
      console.error('Logout error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })
}
