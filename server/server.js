import { registerPlayer, verifyEmailToken } from './auth/registration.js'
import { sendVerificationEmail as defaultMailer } from './auth/email.js'
import { getPlayerProfile, isValidUuid } from './social/profile.js'
import { loginPlayer } from './auth/login.js'
import { createSession, deleteSession, validateAuthHeaders } from './auth/session.js'
import { getDb } from './db.js'
import { getRedis } from './redis.js'
import { createRateLimiter } from './middleware/rateLimiter.js'
import {
  createTable,
  getTable,
  sitAtTable,
  isTableFull,
  markTablePlaying,
  getGameState,
  saveGameState,
} from './lobby/table.js'
import { createGame, placeBid, playCard, submitBlindNilExchange, getPlayerView } from './game/state.js'
import { getSeatForPlayer } from './anticheat/validate.js'

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

  // GET /api/profile/:playerId
  app.get('/api/profile/:playerId', async (req, res) => {
    const { playerId } = req.params
    if (!isValidUuid(playerId)) {
      return sendJSON(res, 400, { error: 'invalid playerId format' })
    }
    try {
      const db = getDb()
      const profile = await getPlayerProfile(db, playerId)
      sendJSON(res, 200, profile)
    } catch (err) {
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      console.error('Profile fetch error:', { playerId, error: err.message })
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

  // ──────────────────────────────────────────────────────────────────────────
  // Table & Game Routes (all require authentication)
  // ──────────────────────────────────────────────────────────────────────────

  // POST /api/tables — create a new table
  app.post('/api/tables', async (req, res) => {
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const table = await createTable(redisClient, { hostPlayerId: session.playerId })
      sendJSON(res, 201, { tableId: table.tableId })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      console.error('Create table error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables/:tableId/sit — sit at a seat
  app.post('/api/tables/:tableId/sit', async (req, res) => {
    const { tableId } = req.params
    const { seat } = req.body ?? {}
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const table = await sitAtTable(redisClient, tableId, session.playerId, seat)

      // If table is now full, start the game
      if (isTableFull(table)) {
        const players = table.seats // { north, east, south, west } → playerIds
        const gameState = createGame(tableId, players)
        await saveGameState(redisClient, tableId, gameState)
        await markTablePlaying(redisClient, tableId, gameState.gameId)
        console.log('Game started:', { tableId, gameId: gameState.gameId })
      }

      sendJSON(res, 200, { tableId, seat })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'GAME_IN_PROGRESS') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'SEAT_TAKEN') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'ALREADY_SEATED') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'INVALID_SEAT') return sendJSON(res, 400, { error: err.message })
      console.error('Sit at table error:', { tableId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // GET /api/tables/:tableId/state — get game state (filtered for this player)
  app.get('/api/tables/:tableId/state', async (req, res) => {
    const { tableId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const table = await getTable(redisClient, tableId)
      if (!table) return sendJSON(res, 404, { error: 'Table not found' })

      const seat = getSeatForPlayer(table.seats, session.playerId)
      if (!seat) return sendJSON(res, 403, { error: 'You are not seated at this table' })

      const gameState = await getGameState(redisClient, tableId)
      if (!gameState) return sendJSON(res, 200, { status: 'waiting', seats: table.seats })

      sendJSON(res, 200, getPlayerView(gameState, seat))
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      console.error('Get game state error:', { tableId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables/:tableId/bid — place a bid
  app.post('/api/tables/:tableId/bid', async (req, res) => {
    const { tableId } = req.params
    const { bid } = req.body ?? {}
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const table = await getTable(redisClient, tableId)
      if (!table) return sendJSON(res, 404, { error: 'Table not found' })

      const seat = getSeatForPlayer(table.seats, session.playerId)
      if (!seat) return sendJSON(res, 403, { error: 'You are not seated at this table' })

      const gameState = await getGameState(redisClient, tableId)
      if (!gameState) return sendJSON(res, 409, { error: 'Game has not started' })

      const newState = placeBid(gameState, seat, bid)
      await saveGameState(redisClient, tableId, newState)
      sendJSON(res, 200, getPlayerView(newState, seat))
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'INVALID_ACTION') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'NOT_YOUR_TURN') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'INVALID_BID') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'NOT_ELIGIBLE') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'ALREADY_BID_BLIND_NIL') return sendJSON(res, 400, { error: err.message })
      console.error('Bid error:', { tableId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables/:tableId/blind-nil-exchange — submit cards for blind nil exchange
  app.post('/api/tables/:tableId/blind-nil-exchange', async (req, res) => {
    const { tableId } = req.params
    const { cards } = req.body ?? {}
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const table = await getTable(redisClient, tableId)
      if (!table) return sendJSON(res, 404, { error: 'Table not found' })

      const seat = getSeatForPlayer(table.seats, session.playerId)
      if (!seat) return sendJSON(res, 403, { error: 'You are not seated at this table' })

      const gameState = await getGameState(redisClient, tableId)
      if (!gameState) return sendJSON(res, 409, { error: 'Game has not started' })

      const newState = submitBlindNilExchange(gameState, seat, cards)
      await saveGameState(redisClient, tableId, newState)
      sendJSON(res, 200, getPlayerView(newState, seat))
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'INVALID_ACTION') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'INVALID_EXCHANGE') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'CARD_NOT_IN_HAND') return sendJSON(res, 400, { error: err.message })
      console.error('Blind nil exchange error:', { tableId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables/:tableId/play — play a card
  app.post('/api/tables/:tableId/play', async (req, res) => {
    const { tableId } = req.params
    const { card } = req.body ?? {}
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const table = await getTable(redisClient, tableId)
      if (!table) return sendJSON(res, 404, { error: 'Table not found' })

      const seat = getSeatForPlayer(table.seats, session.playerId)
      if (!seat) return sendJSON(res, 403, { error: 'You are not seated at this table' })

      const gameState = await getGameState(redisClient, tableId)
      if (!gameState) return sendJSON(res, 409, { error: 'Game has not started' })

      const newState = playCard(gameState, seat, card)
      await saveGameState(redisClient, tableId, newState)
      sendJSON(res, 200, getPlayerView(newState, seat))
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'INVALID_ACTION') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'NOT_YOUR_TURN') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'CARD_NOT_IN_HAND') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'ILLEGAL_PLAY') return sendJSON(res, 400, { error: err.message })
      console.error('Play card error:', { tableId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })
}
