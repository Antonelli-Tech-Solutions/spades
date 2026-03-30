import { registerPlayer, verifyEmailToken } from './auth/registration.js'
import { sendVerificationEmail as defaultMailer } from './auth/email.js'
import { getDb } from './db.js'
import { createRateLimiter } from './middleware/rateLimiter.js'

function sendJSON(res, statusCode, data) {
  res.status(statusCode).json(data)
}

// Defaults are configurable via environment variables.
const DEFAULT_AUTH_RATE_LIMIT = {
  maxRequests: parseInt(process.env.AUTH_RATE_LIMIT_MAX ?? '10', 10),
  windowSeconds: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW ?? '900', 10),
  keyPrefix: 'auth',
}

/**
 * Register all API route handlers on the given Express app.
 *
 * @param {import('express').Application} app
 * @param {object} [opts]
 * @param {(email: string, token: string) => Promise<void>} [opts.mailer]
 * @param {object} [opts.redis]           - Connected redis v4 client; rate limiting is
 *                                          disabled when omitted (e.g. in unit tests).
 * @param {object} [opts.rateLimitConfig] - Overrides for rate limit defaults (maxRequests,
 *                                          windowSeconds, keyPrefix).
 */
export function handler(app, { mailer, redis, rateLimitConfig } = {}) {
  const emailer = mailer ?? defaultMailer

  const limitConfig = { ...DEFAULT_AUTH_RATE_LIMIT, ...rateLimitConfig }
  // When no Redis client is provided (e.g. unit tests without Redis), skip rate limiting.
  const authRateLimiter = redis
    ? createRateLimiter(redis, limitConfig)
    : (req, res, next) => next()

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
}
