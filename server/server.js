import { registerPlayer, verifyEmailToken, resendVerificationEmail } from './auth/registration.js'
import { forgotPassword, resetPassword } from './auth/passwordReset.js'
import { sendVerificationEmail as defaultMailer, sendPasswordResetEmail as defaultPasswordResetMailer } from './auth/email.js'
import { getPlayerProfile, isValidUuid } from './social/profile.js'
import { loginPlayer } from './auth/login.js'
import { createSession, deleteSession, getSession, validateAuthHeaders } from './auth/session.js'
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
  listTables,
  addBotToTable,
  removePlayerFromTables,
} from './lobby/table.js'
import { createGame, placeBid, playCard, submitBlindNilExchange, revealHand, getPlayerView } from './game/state.js'
import { getPartnerSeat } from './game/bid.js'
import { getSeatForPlayer, validateCardPlay, validateBidTurn } from './anticheat/validate.js'
import { isBot, botBid, botPlay, botBlindNilExchange } from './game/bot.js'

function sendJSON(res, statusCode, data) {
  res.status(statusCode).json(data)
}

/**
 * Automatically advance the game state through any consecutive bot turns.
 * Loops until it is a human player's turn or the game is over.
 *
 * @param {object} state - Current game state
 * @returns {object} Updated game state after all bot actions are applied
 */
function advanceBotTurns(state) {
  let current = state
  while (true) {
    if (current.phase === 'bidding') {
      const seat = current.currentBidderSeat
      if (!seat || !isBot(current.players[seat])) break
      const partnerSeat = getPartnerSeat(seat)
      const partnerBid = current.bids[partnerSeat]
      const bid = botBid(current.hands[seat], partnerBid)
      console.log('Bot bid:', { seat, bid, tableId: current.tableId })
      current = placeBid(current, seat, bid)
    } else if (current.phase === 'playing') {
      const seat = current.currentPlayerSeat
      if (!seat || !isBot(current.players[seat])) break
      const card = botPlay(current.hands[seat], current.currentTrick, current.spadesbroken, current.isFirstTrick)
      console.log('Bot play:', { seat, card, tableId: current.tableId })
      current = playCard(current, seat, card)
    } else if (current.phase === 'blind_nil_exchange') {
      const { currentBlindNilSeat, step } = current.blindNilExchange
      // Bots never bid blind nil, so they can only act as the partner (step: partner_to_blind)
      if (step !== 'partner_to_blind') break
      const partnerSeat = getPartnerSeat(currentBlindNilSeat)
      if (!isBot(current.players[partnerSeat])) break
      const cards = botBlindNilExchange(current.hands[partnerSeat])
      console.log('Bot blind nil exchange:', { seat: partnerSeat, cards, tableId: current.tableId })
      current = submitBlindNilExchange(current, partnerSeat, cards)
    } else {
      // game_over — nothing to auto-advance
      break
    }
  }
  return current
}

/**
 * Register all API route handlers on the given Express app.
 *
 * @param {import('express').Application} app
 * @param {{ mailer?: (email: string, token: string) => Promise<void>, redis?: object, rateLimitConfig?: { max?: number, windowSecs?: number } }} [opts]
 */
export function handler(app, { mailer, passwordResetMailer, redis, rateLimitConfig } = {}) {
  const emailer = mailer ?? defaultMailer
  const passwordResetEmailer = passwordResetMailer ?? defaultPasswordResetMailer
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
      return res.redirect('/#/verify-email-success')
    } catch (err) {
      if (err.code === 'EXPIRED_TOKEN') return res.redirect('/#/verify-email-expired')
      if (err.code === 'VALIDATION_ERROR' || err.code === 'INVALID_TOKEN') {
        return res.redirect('/#/verify-email-error')
      }
      console.error('Email verification error:', { error: err.message })
      return res.redirect('/#/verify-email-error')
    }
  })

  // POST /api/auth/resend-verification
  app.post('/api/auth/resend-verification', authRateLimiter, async (req, res) => {
    const { email } = req.body ?? {}
    try {
      const db = getDb()
      await resendVerificationEmail(db, email || '', emailer)
      sendJSON(res, 200, {
        message: 'If this email is registered and unverified, a new verification link has been sent.',
      })
    } catch (err) {
      console.error('Resend verification error:', { error: err.message })
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

  // POST /api/auth/forgot-password
  app.post('/api/auth/forgot-password', authRateLimiter, async (req, res) => {
    const { email } = req.body ?? {}
    try {
      const db = getDb()
      await forgotPassword(db, email || '', passwordResetEmailer)
      sendJSON(res, 200, {
        message: 'If that email address is registered, you will receive a password reset link shortly.',
      })
    } catch (err) {
      console.error('Forgot password error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/auth/reset-password
  app.post('/api/auth/reset-password', authRateLimiter, async (req, res) => {
    const { token, newPassword } = req.body ?? {}
    try {
      const db = getDb()
      await resetPassword(db, token, newPassword)
      sendJSON(res, 200, { message: 'Password reset successfully. You may now sign in.' })
    } catch (err) {
      if (err.code === 'VALIDATION_ERROR') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'INVALID_TOKEN') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'EXPIRED_TOKEN') return sendJSON(res, 400, { error: err.message })
      console.error('Reset password error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/auth/logout
  app.post('/api/auth/logout', async (req, res) => {
    const sessionId = req.headers['x-session-id']
    try {
      const redis = await getRedis()
      const session = await getSession(redis, sessionId)
      if (session) {
        await removePlayerFromTables(redis, session.playerId)
      }
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

  // GET /api/tables — list open (waiting) tables
  app.get('/api/tables', async (req, res) => {
    try {
      const redisClient = await getRedis()
      await validateAuthHeaders(redisClient, req)
      const tables = await listTables(redisClient)
      sendJSON(res, 200, { tables })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      console.error('List tables error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables — create a new table
  app.post('/api/tables', async (req, res) => {
    const { name } = req.body ?? {}
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string') return sendJSON(res, 400, { error: 'Table name must be a string.' })
      const trimmed = name.trim()
      if (trimmed.length > 50) return sendJSON(res, 400, { error: 'Table name must be 50 characters or fewer.' })
    }
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const resolvedName = (typeof name === 'string' && name.trim()) ? name.trim() : null
      const table = await createTable(redisClient, { hostPlayerId: session.playerId, name: resolvedName })
      sendJSON(res, 201, { tableId: table.tableId, name: table.name })
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

      // If table is now full, start the game and advance any leading bot turns
      if (isTableFull(table)) {
        const players = table.seats // { north, east, south, west } → playerIds
        let gameState = createGame(tableId, players)
        gameState = advanceBotTurns(gameState)
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

  // POST /api/tables/:tableId/add-bot — add a bot to an empty seat (host only)
  app.post('/api/tables/:tableId/add-bot', async (req, res) => {
    const { tableId } = req.params
    const { seat } = req.body ?? {}
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const table = await getTable(redisClient, tableId)
      if (!table) return sendJSON(res, 404, { error: 'Table not found' })
      if (table.hostPlayerId !== session.playerId) {
        return sendJSON(res, 403, { error: 'Only the host can add bots' })
      }

      const updated = await addBotToTable(redisClient, tableId, seat)

      // If table is now full, start the game and advance any leading bot turns
      if (isTableFull(updated)) {
        const players = updated.seats
        let gameState = createGame(tableId, players)
        gameState = advanceBotTurns(gameState)
        await saveGameState(redisClient, tableId, gameState)
        await markTablePlaying(redisClient, tableId, gameState.gameId)
        console.log('Game started with bots:', { tableId, gameId: gameState.gameId })
      }

      sendJSON(res, 200, { tableId, seat })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'GAME_IN_PROGRESS') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'SEAT_TAKEN') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'INVALID_SEAT') return sendJSON(res, 400, { error: err.message })
      console.error('Add bot error:', { tableId, error: err.message })
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
      if (!gameState) return sendJSON(res, 200, { status: 'waiting', seats: table.seats, isHost: table.hostPlayerId === session.playerId })

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

      validateBidTurn(gameState, seat)
      let newState = placeBid(gameState, seat, bid)
      newState = advanceBotTurns(newState)
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

      let newState = submitBlindNilExchange(gameState, seat, cards)
      newState = advanceBotTurns(newState)
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

  // POST /api/tables/:tableId/reveal-hand — reveal hand for a Blind Nil eligible player
  app.post('/api/tables/:tableId/reveal-hand', async (req, res) => {
    const { tableId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const table = await getTable(redisClient, tableId)
      if (!table) return sendJSON(res, 404, { error: 'Table not found' })

      const seat = getSeatForPlayer(table.seats, session.playerId)
      if (!seat) return sendJSON(res, 403, { error: 'You are not seated at this table' })

      const gameState = await getGameState(redisClient, tableId)
      if (!gameState) return sendJSON(res, 409, { error: 'Game has not started' })

      const newState = revealHand(gameState, seat)
      await saveGameState(redisClient, tableId, newState)
      sendJSON(res, 200, getPlayerView(newState, seat))
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'INVALID_ACTION') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'NOT_ELIGIBLE') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'BID_ALREADY_PLACED') return sendJSON(res, 409, { error: err.message })
      console.error('Reveal hand error:', { tableId, error: err.message })
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

      validateCardPlay(gameState, seat, card)
      let newState = playCard(gameState, seat, card)
      newState = advanceBotTurns(newState)
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
