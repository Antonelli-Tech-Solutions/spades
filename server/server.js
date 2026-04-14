import { registerPlayer, verifyEmailToken, resendVerificationEmail } from './auth/registration.js'
import { forgotPassword, resetPassword } from './auth/passwordReset.js'
import { sendVerificationEmail as defaultMailer, sendPasswordResetEmail as defaultPasswordResetMailer } from './auth/email.js'
import { getPlayerProfile, getPlayerUsernames, isValidUuid } from './social/profile.js'
import {
  areFriends,
  searchPlayers,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  getFriends,
  getPendingRequests,
  removeFriend,
} from './social/friends.js'
import {
  blockPlayer,
  unblockPlayer,
  getBlockList,
  isBlockedEitherDirection,
} from './social/block.js'
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
  terminateTable,
  findTableForPlayer,
  leaveTable,
  leaveInProgressGame,
  changeSeat,
  joinTable,
  standFromSeat,
  VALID_VISIBILITIES,
  VALID_JOIN_POLICIES,
  validateJoinPolicy,
  createJoinLink,
  validateJoinLink,
  createSpectatorLink,
  validateSpectatorLink,
  arriveAtTable,
  markPlayerInvited,
  canSeeTable,
  canGoToTable,
} from './lobby/table.js'
import { createGame, placeBid, playCard, submitBlindNilExchange, revealHand, getPlayerView, getSpectatorView, substitutePlayerWithBot } from './game/state.js'
import { getSeatForPlayer, validateCardPlay, validateBidTurn } from './anticheat/validate.js'
import { isBot, botBid, botPlay, botBlindNilExchange } from './game/bot.js'
import { getPartnerSeat, isEligibleForBlindNil } from './game/bid.js'

function sendJSON(res, statusCode, data) {
  res.status(statusCode).json(data)
}

// ── WebSocket event emission helpers ─────────────────────────────────────────

/** Return the active seat for TURN_CHANGED payload. */
function getActiveSeat(state) {
  if (state.phase === 'bidding') return state.currentBidderSeat
  if (state.phase === 'playing') return state.currentPlayerSeat
  if (state.phase === 'blind_nil_exchange') {
    const { step, currentBlindNilSeat } = state.blindNilExchange
    return step === 'blind_to_partner' ? currentBlindNilSeat : getPartnerSeat(currentBlindNilSeat)
  }
  return null
}

/**
 * Emit HAND_DEALT to each player individually (security: only their own cards).
 * Players eligible for Blind Nil do not receive myHand until they reveal or bid Blind Nil.
 */
function emitHandDealt(wss, state) {
  for (const seat of ['north', 'east', 'south', 'west']) {
    const playerId = state.players[seat]
    const eligible = isEligibleForBlindNil(state.scores, seat)
    const payload = {
      dealer: state.dealerSeat,
      biddingOrder: state.biddingOrder,
      blindNilEligible: eligible,
    }
    if (!eligible) {
      payload.myHand = state.hands[seat]
    }
    wss.sendToPlayer(playerId, 'HAND_DEALT', payload)
  }
}

/**
 * Emit BLIND_NIL_EXCHANGE_PROMPT to the relevant player(s) based on the current exchange step.
 * step='blind_to_partner': blind nil player gets direction='send', partner gets direction='receive'.
 * step='partner_to_blind': partner gets direction='send' (their turn to send cards back).
 */
function emitBlindNilExchangePrompts(wss, state) {
  const { currentBlindNilSeat, step } = state.blindNilExchange
  const partnerSeat = getPartnerSeat(currentBlindNilSeat)

  if (step === 'blind_to_partner') {
    wss.sendToPlayer(state.players[currentBlindNilSeat], 'BLIND_NIL_EXCHANGE_PROMPT', { direction: 'send', count: 2, step, currentBlindNilSeat })
    wss.sendToPlayer(state.players[partnerSeat], 'BLIND_NIL_EXCHANGE_PROMPT', { direction: 'receive', count: 2, step, currentBlindNilSeat })
  } else {
    // step === 'partner_to_blind': partner now sends cards back
    wss.sendToPlayer(state.players[partnerSeat], 'BLIND_NIL_EXCHANGE_PROMPT', { direction: 'send', count: 2, step, currentBlindNilSeat })
  }
}

/**
 * Emit HAND_SCORED after all 13 tricks are played. Also emits GAME_OVER or HAND_DEALT
 * depending on whether the game ended or a new hand begins.
 * Reads score data from the last handHistory entry.
 */
function emitHandComplete(wss, tableId, newState) {
  const lastEntry = newState.handHistory[newState.handHistory.length - 1]
  wss.broadcast(tableId, 'HAND_SCORED', {
    scoreDelta: lastEntry.scoreDelta,
    newTotals: lastEntry.scoresAfter,
    bags: lastEntry.bagsAfter,
  })
  if (newState.phase === 'game_over') {
    wss.broadcast(tableId, 'GAME_OVER', {
      winningTeam: newState.winner,
      finalScores: newState.scores,
    })
  } else {
    emitHandDealt(wss, newState)
  }
}

/**
 * Advance bot turns step-by-step, emitting WebSocket events for each bot action.
 * When wss is null/undefined, behaves identically to the game engine's advanceBotTurns.
 */
function advanceBotsWithEvents(state, wss, tableId) {
  let current = state
  while (true) {
    if (current.phase === 'bidding') {
      const seat = current.currentBidderSeat
      if (!seat || !isBot(current.players[seat])) break
      const bid = botBid(current.hands[seat], current.bids[getPartnerSeat(seat)])
      console.log('Bot bid:', { seat, bid, tableId: current.tableId })
      current = placeBid(current, seat, bid)
      if (wss) {
        const bidType = bid === 'nil' ? 'nil' : bid === 'blind_nil' ? 'blindNil' : 'number'
        const bidPayload = bidType === 'number' ? { seat, bidType, bid } : { seat, bidType }
        wss.broadcast(tableId, 'BID_PLACED', bidPayload)
        if (current.phase === 'blind_nil_exchange') {
          emitBlindNilExchangePrompts(wss, current)
        }
        wss.broadcast(tableId, 'TURN_CHANGED', { activeSeat: getActiveSeat(current), phase: current.phase })
      }
    } else if (current.phase === 'playing') {
      const seat = current.currentPlayerSeat
      if (!seat || !isBot(current.players[seat])) break
      const card = botPlay(current.hands[seat], current.currentTrick, current.spadesbroken, current.isFirstTrick)
      const prevCompletedLen = current.completedTricks.length
      const prevPhase = current.phase
      const trickWithCard = [...current.currentTrick, { seat, card }]
      console.log('Bot play:', { seat, card, tableId: current.tableId })
      current = playCard(current, seat, card)
      if (wss) {
        wss.broadcast(tableId, 'CARD_PLAYED', { seat, card, currentTrick: trickWithCard, nextPlayerSeat: current.currentPlayerSeat, spadesBroken: current.spadesbroken })
        // trickJustCompleted: tricks 1-12 AND 13th trick when game-over (length grows 12→13)
        const trickJustCompleted = current.completedTricks.length > prevCompletedLen
        // handJustScored: phase left 'playing' — either new hand or game over
        const handJustScored = prevPhase === 'playing' && current.phase !== 'playing'
        if (trickJustCompleted) {
          const trick = current.completedTricks[current.completedTricks.length - 1]
          wss.broadcast(tableId, 'TRICK_COMPLETE', { winnerSeat: trick.winner, plays: trick.plays, tricksWon: current.tricksWon })
        } else if (handJustScored) {
          // New-hand 13th trick: completedTricks reset to [] so trickJustCompleted is false
          const lastEntry = current.handHistory[current.handHistory.length - 1]
          if (lastEntry?.lastTrick) {
            wss.broadcast(tableId, 'TRICK_COMPLETE', {
              winnerSeat: lastEntry.lastTrick.winner,
              plays: lastEntry.lastTrick.plays,
              tricksWon: lastEntry.tricksWon,
            })
          }
        }
        if (handJustScored) {
          emitHandComplete(wss, tableId, current)
          if (current.phase === 'game_over') break
          // New hand started — continue loop (may have bot bids for new hand)
        }
        wss.broadcast(tableId, 'TURN_CHANGED', { activeSeat: getActiveSeat(current), phase: current.phase })
      }
    } else if (current.phase === 'blind_nil_exchange') {
      const { currentBlindNilSeat, step } = current.blindNilExchange
      // Bots never bid blind nil, so they only act as partner (step: partner_to_blind)
      if (step !== 'partner_to_blind') break
      const partnerSeat = getPartnerSeat(currentBlindNilSeat)
      if (!isBot(current.players[partnerSeat])) break
      const cards = botBlindNilExchange(current.hands[partnerSeat])
      console.log('Bot blind nil exchange:', { seat: partnerSeat, cards, tableId: current.tableId })
      current = submitBlindNilExchange(current, partnerSeat, cards)
      if (wss) {
        if (current.phase === 'blind_nil_exchange') {
          emitBlindNilExchangePrompts(wss, current)
        }
        wss.broadcast(tableId, 'TURN_CHANGED', { activeSeat: getActiveSeat(current), phase: current.phase })
      }
    } else {
      break
    }
  }
  return current
}

// ── Lobby event helpers ───────────────────────────────────────────────────────

/**
 * Emit TABLE_CREATED to the lobby channel for a Public table.
 * No-ops when wss is not configured or the table is not public.
 */
function emitLobbyTableCreated(wss, table) {
  if (!wss || table.visibility !== 'public') return
  wss.broadcastLobby('TABLE_CREATED', {
    tableId: table.tableId,
    name: table.name,
    host: table.hostPlayerId,
    seats: table.seats,
    visibility: table.visibility,
  })
}

/**
 * Emit TABLE_UPDATED to the lobby channel for a Public table.
 * No-ops when wss is not configured or the table is not public.
 */
function emitLobbyTableUpdated(wss, table) {
  if (!wss || table.visibility !== 'public') return
  wss.broadcastLobby('TABLE_UPDATED', {
    tableId: table.tableId,
    name: table.name,
    host: table.hostPlayerId,
    seats: table.seats,
    status: table.status,
    visibility: table.visibility,
    observerCount: (table.observers || []).length,
    spectating: table.spectating,
  })
}

/**
 * Emit TABLE_REMOVED to the lobby channel. Called before the table is deleted,
 * using the stored visibility to decide whether to broadcast.
 * No-ops when wss is not configured or the table was not public.
 */
function emitLobbyTableRemoved(wss, table) {
  if (!wss || table.visibility !== 'public') return
  wss.broadcastLobby('TABLE_REMOVED', { tableId: table.tableId })
}

/**
 * Enrich raw seat data (seat → playerId | null) with player names and bot flags.
 * Returns a new object with the same keys but values of:
 *   - null for empty seats
 *   - { playerId, username, isBot: true } for bot seats
 *   - { playerId, username, isBot: false } for human seats
 *
 * @param {object} db - pg Pool
 * @param {{ [seat: string]: string|null }} seats
 * @returns {Promise<{ [seat: string]: { playerId: string, username: string, isBot: boolean }|null }>}
 */
async function enrichSeats(db, seats) {
  const enriched = {}
  const humanEntries = []

  for (const [seat, playerId] of Object.entries(seats)) {
    if (playerId === null) {
      enriched[seat] = null
    } else if (playerId.startsWith('bot:')) {
      enriched[seat] = { playerId, username: 'Bot', isBot: true }
    } else {
      humanEntries.push([seat, playerId])
    }
  }

  if (humanEntries.length > 0) {
    const playerIds = humanEntries.map(([, id]) => id)
    const usernames = await getPlayerUsernames(db, playerIds)
    for (const [seat, playerId] of humanEntries) {
      enriched[seat] = { playerId, username: usernames[playerId] ?? null, isBot: false }
    }
  }

  return enriched
}

/**
 * Enrich an observer list (array of playerIds) with usernames.
 * @param {object} db - pg Pool
 * @param {string[]} observerIds
 * @returns {Promise<Array<{ playerId: string, username: string|null }>>}
 */
async function enrichObservers(db, observerIds) {
  if (!observerIds || observerIds.length === 0) return []
  const usernames = await getPlayerUsernames(db, observerIds)
  return observerIds.map((id) => ({ playerId: id, username: usernames[id] ?? null }))
}

/**
 * Register all API route handlers on the given Express app.
 *
 * @param {import('express').Application} app
 * @param {{ mailer?: (email: string, token: string) => Promise<void>, redis?: object, rateLimitConfig?: { max?: number, windowSecs?: number } }} [opts]
 */
export function handler(app, { mailer, passwordResetMailer, redis, rateLimitConfig, wss } = {}) {
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
      if (result.autoVerified) {
        const redis = await getRedis()
        const sessionId = await createSession(redis, {
          playerId: result.playerId,
          email: result.email,
          username: result.username,
        })
        return sendJSON(res, 201, {
          sessionId,
          playerId: result.playerId,
          username: result.username,
        })
      }
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
        const { updated, terminated } = await removePlayerFromTables(redis, session.playerId)
        for (const table of updated) {
          emitLobbyTableUpdated(wss, table)
        }
        for (const table of terminated) {
          emitLobbyTableRemoved(wss, table)
        }
      }
      await deleteSession(redis, sessionId)
      sendJSON(res, 200, { message: 'Logged out successfully.' })
    } catch (err) {
      console.error('Logout error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Social / Friends Routes
  // ──────────────────────────────────────────────────────────────────────────

  const socialRateLimiter = createRateLimiter(redis ?? null, {
    keyPrefix: 'social',
    ...rateLimitConfig,
  })

  // GET /api/players/search?username=<query>
  app.get('/api/players/search', socialRateLimiter, async (req, res) => {
    const { username } = req.query
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const db = getDb()
      const players = await searchPlayers(db, username, session.playerId)
      sendJSON(res, 200, { players })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'VALIDATION_ERROR') return sendJSON(res, 400, { error: err.message })
      console.error('Player search error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/friends/request
  app.post('/api/friends/request', socialRateLimiter, async (req, res) => {
    const { playerId: toPlayerId } = req.body ?? {}
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const db = getDb()
      const blocked = await isBlockedEitherDirection(db, session.playerId, toPlayerId)
      if (blocked) return sendJSON(res, 403, { error: 'Cannot send friend request to this player.' })
      await sendFriendRequest(db, session.playerId, toPlayerId)
      sendJSON(res, 201, { message: 'Friend request sent.' })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'VALIDATION_ERROR') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'DUPLICATE') return sendJSON(res, 409, { error: err.message })
      console.error('Friend request error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/friends/accept
  app.post('/api/friends/accept', async (req, res) => {
    const { playerId: requesterId } = req.body ?? {}
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const db = getDb()
      const blocked = await isBlockedEitherDirection(db, session.playerId, requesterId)
      if (blocked) return sendJSON(res, 403, { error: 'Cannot accept friend request from this player.' })
      await acceptFriendRequest(db, session.playerId, requesterId)
      sendJSON(res, 200, { message: 'Friend request accepted.' })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'VALIDATION_ERROR') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      console.error('Accept friend request error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/friends/decline
  app.post('/api/friends/decline', async (req, res) => {
    const { playerId: requesterId } = req.body ?? {}
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const db = getDb()
      await declineFriendRequest(db, session.playerId, requesterId)
      sendJSON(res, 200, { message: 'Friend request declined.' })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'VALIDATION_ERROR') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      console.error('Decline friend request error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // GET /api/friends
  app.get('/api/friends', async (req, res) => {
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const db = getDb()
      const friends = await getFriends(db, session.playerId)
      const pending = await getPendingRequests(db, session.playerId)
      sendJSON(res, 200, { friends, pending })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      console.error('Get friends error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // DELETE /api/friends/:playerId
  app.delete('/api/friends/:playerId', async (req, res) => {
    const { playerId: friendId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const db = getDb()
      await removeFriend(db, session.playerId, friendId)
      sendJSON(res, 200, { message: 'Friend removed.' })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'VALIDATION_ERROR') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      console.error('Remove friend error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // GET /api/friends/:friendId/table — check if a friend is at a visible table
  app.get('/api/friends/:friendId/table', async (req, res) => {
    const { friendId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const db = getDb()
      const friends = await areFriends(db, session.playerId, friendId)
      if (!friends) return sendJSON(res, 403, { error: 'Not friends with this player' })
      const tableId = await findTableForPlayer(redisClient, friendId)
      if (!tableId) return sendJSON(res, 200, { table: null })
      const table = await getTable(redisClient, tableId)
      if (!table) return sendJSON(res, 200, { table: null })
      const visible = await canSeeTable(db, table, session.playerId, { areFriends })
      if (!visible) return sendJSON(res, 200, { table: null })
      const goToTable = await canGoToTable(redisClient, db, table, session.playerId, { areFriends, knownVisible: visible })
      sendJSON(res, 200, {
        table: {
          tableId: table.tableId,
          name: table.name,
          hostPlayerId: table.hostPlayerId,
          status: table.status,
          visibility: table.visibility,
          spectating: table.spectating,
        },
        canGoToTable: goToTable,
      })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      console.error('Get friend table error:', { friendId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/friends/:friendId/go-to-table — navigate to a friend's table (arrive as observer)
  app.post('/api/friends/:friendId/go-to-table', async (req, res) => {
    const { friendId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const db = getDb()
      const friends = await areFriends(db, session.playerId, friendId)
      if (!friends) {
        return sendJSON(res, 403, { error: 'Not friends with this player' })
      }
      const tableId = await findTableForPlayer(redisClient, friendId)
      if (!tableId) {
        return sendJSON(res, 404, { error: 'Friend is not at a table' })
      }
      const table = await getTable(redisClient, tableId)
      if (!table) {
        return sendJSON(res, 404, { error: 'Friend is not at a table' })
      }
      const goToTable = await canGoToTable(redisClient, db, table, session.playerId, { areFriends })
      if (!goToTable) {
        return sendJSON(res, 403, { error: 'You do not have permission to go to this table' })
      }
      const updated = await arriveAtTable(redisClient, tableId, session.playerId)
      emitLobbyTableUpdated(wss, updated)
      if (wss) wss.broadcast(tableId, 'OBSERVER_JOINED', { playerId: session.playerId })
      sendJSON(res, 200, { tableId })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'FORBIDDEN') return sendJSON(res, 403, { error: err.message })
      if (err.code === 'OBSERVERS_FULL') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'CONCURRENT_MODIFICATION') return sendJSON(res, 409, { error: err.message })
      console.error('Go to friend table error:', { friendId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // ──────────────────────────────────────────────────────────────────────────
  // Block Routes
  // ──────────────────────────────────────────────────────────────────────────

  // POST /api/players/:playerId/block
  app.post('/api/players/:playerId/block', async (req, res) => {
    const { playerId: blockedId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const db = getDb()
      await blockPlayer(db, session.playerId, blockedId)
      sendJSON(res, 201, { message: 'Player blocked.' })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'VALIDATION_ERROR') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      console.error('Block player error:', { blockedId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // DELETE /api/players/:playerId/block
  app.delete('/api/players/:playerId/block', async (req, res) => {
    const { playerId: blockedId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const db = getDb()
      await unblockPlayer(db, session.playerId, blockedId)
      sendJSON(res, 200, { message: 'Player unblocked.' })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'VALIDATION_ERROR') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      console.error('Unblock player error:', { blockedId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // GET /api/players/blocked
  app.get('/api/players/blocked', async (req, res) => {
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const db = getDb()
      const blocked = await getBlockList(db, session.playerId)
      sendJSON(res, 200, { blocked })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      console.error('Get block list error:', { error: err.message })
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
      const db = getDb()
      const enrichedTables = await Promise.all(
        tables.map(async (t) => ({ ...t, seats: await enrichSeats(db, t.seats) })),
      )
      sendJSON(res, 200, { tables: enrichedTables })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      console.error('List tables error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // GET /api/player/table — returns the tableId if the authenticated player is seated at an active table
  app.get('/api/player/table', async (req, res) => {
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const tableId = await findTableForPlayer(redisClient, session.playerId)
      sendJSON(res, 200, { tableId: tableId ?? null })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      console.error('Get player table error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables — create a new table
  app.post('/api/tables', async (req, res) => {
    const { name, visibility, joinPolicy, spectating } = req.body ?? {}
    if (name !== undefined && name !== null) {
      if (typeof name !== 'string') return sendJSON(res, 400, { error: 'Table name must be a string.' })
      const trimmed = name.trim()
      if (trimmed.length > 50) return sendJSON(res, 400, { error: 'Table name must be 50 characters or fewer.' })
    }
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      if (visibility !== undefined && visibility !== null && !VALID_VISIBILITIES.includes(visibility)) {
        return sendJSON(res, 400, { error: `Invalid visibility. Must be one of: ${VALID_VISIBILITIES.join(', ')}` })
      }
      const resolvedVisibility = visibility ?? 'public'
      if (joinPolicy !== undefined && joinPolicy !== null && !VALID_JOIN_POLICIES.includes(joinPolicy)) {
        return sendJSON(res, 400, { error: `Invalid joinPolicy. Must be one of: ${VALID_JOIN_POLICIES.join(', ')}` })
      }
      if (spectating !== undefined && spectating !== null && typeof spectating !== 'boolean') {
        return sendJSON(res, 400, { error: 'spectating must be a boolean.' })
      }
      const joinPolicyError = validateJoinPolicy(resolvedVisibility, joinPolicy)
      if (joinPolicyError) {
        return sendJSON(res, 400, { error: joinPolicyError })
      }
      const resolvedName = (typeof name === 'string' && name.trim()) ? name.trim() : null
      const table = await createTable(redisClient, {
        hostPlayerId: session.playerId,
        name: resolvedName,
        visibility: resolvedVisibility,
        joinPolicy,
        spectating: spectating !== undefined && spectating !== null ? spectating : true,
      })
      // Auto-seat the host at north
      const seatedTable = await sitAtTable(redisClient, table.tableId, session.playerId, 'north')
      emitLobbyTableCreated(wss, seatedTable)
      sendJSON(res, 201, {
        tableId: table.tableId,
        name: table.name,
        visibility: table.visibility,
        joinPolicy: table.joinPolicy,
        spectating: table.spectating,
      })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      console.error('Create table error:', { error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables/:tableId/arrive — arrive at a table as observer
  app.post('/api/tables/:tableId/arrive', async (req, res) => {
    const { tableId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const table = await arriveAtTable(redisClient, tableId, session.playerId)
      emitLobbyTableUpdated(wss, table)
      if (wss) wss.broadcast(tableId, 'OBSERVER_JOINED', { playerId: session.playerId })
      sendJSON(res, 200, { tableId })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'FORBIDDEN') return sendJSON(res, 403, { error: err.message })
      if (err.code === 'OBSERVERS_FULL') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'CONCURRENT_MODIFICATION') return sendJSON(res, 409, { error: err.message })
      console.error('Arrive at table error:', { tableId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables/:tableId/join — join a table as observer
  app.post('/api/tables/:tableId/join', async (req, res) => {
    const { tableId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const table = await joinTable(redisClient, tableId, session.playerId)
      emitLobbyTableUpdated(wss, table)
      if (wss) wss.broadcast(tableId, 'OBSERVER_JOINED', { playerId: session.playerId })
      sendJSON(res, 200, { tableId })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'FORBIDDEN') return sendJSON(res, 403, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'OBSERVERS_FULL') return sendJSON(res, 409, { error: err.message })
      console.error('Join table error:', { tableId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables/:tableId/stand — stand up from seat, become observer
  app.post('/api/tables/:tableId/stand', async (req, res) => {
    const { tableId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const result = await standFromSeat(redisClient, tableId, session.playerId)
      emitLobbyTableUpdated(wss, result.table)
      if (wss) {
        wss.broadcast(tableId, 'SEAT_VACATED', { seat: result.seat })
        wss.broadcast(tableId, 'OBSERVER_JOINED', { playerId: session.playerId })
        if (result.hostChanged) {
          const newHostSeat = Object.entries(result.table.seats).find(([, pid]) => pid === result.table.hostPlayerId)?.[0] ?? null
          wss.broadcast(tableId, 'HOST_CHANGED', { newHostPlayerId: result.table.hostPlayerId, newHostSeat })
        }
      }
      sendJSON(res, 200, { tableId, previousSeat: result.seat })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'GAME_IN_PROGRESS') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'NOT_SEATED') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'HOST_MUST_SIT') return sendJSON(res, 409, { error: err.message })
      console.error('Stand from seat error:', { tableId, error: err.message })
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
      const db = getDb()
      const table = await sitAtTable(redisClient, tableId, session.playerId, seat, {
        policyDeps: { db, areFriends },
      })

      // If table is now full, start the game and advance any leading bot turns
      if (isTableFull(table)) {
        const players = table.seats // { north, east, south, west } → playerIds
        let gameState = createGame(tableId, players)
        gameState = advanceBotsWithEvents(gameState, wss, tableId)
        await saveGameState(redisClient, tableId, gameState)
        const playingTable = await markTablePlaying(redisClient, tableId, gameState.gameId)
        emitLobbyTableUpdated(wss, playingTable)
        if (wss) {
          wss.broadcast(tableId, 'GAME_STARTED', {})
          emitHandDealt(wss, gameState)
          wss.broadcast(tableId, 'TURN_CHANGED', { activeSeat: getActiveSeat(gameState), phase: gameState.phase })
        }
        console.log('Game started:', { tableId, gameId: gameState.gameId })
      } else {
        emitLobbyTableUpdated(wss, table)
        if (wss) wss.broadcast(tableId, 'SEAT_TAKEN', { seat })
      }

      sendJSON(res, 200, { tableId, seat })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'FORBIDDEN') return sendJSON(res, 403, { error: err.message })
      if (err.code === 'GAME_IN_PROGRESS') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'SEAT_TAKEN') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'ALREADY_SEATED') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'INVALID_SEAT') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'CONCURRENT_MODIFICATION') return sendJSON(res, 409, { error: err.message })
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
        gameState = advanceBotsWithEvents(gameState, wss, tableId)
        await saveGameState(redisClient, tableId, gameState)
        const playingTable = await markTablePlaying(redisClient, tableId, gameState.gameId)
        emitLobbyTableUpdated(wss, playingTable)
        if (wss) {
          wss.broadcast(tableId, 'GAME_STARTED', {})
          emitHandDealt(wss, gameState)
          wss.broadcast(tableId, 'TURN_CHANGED', { activeSeat: getActiveSeat(gameState), phase: gameState.phase })
        }
        console.log('Game started with bots:', { tableId, gameId: gameState.gameId })
      } else {
        emitLobbyTableUpdated(wss, updated)
        if (wss) wss.broadcast(tableId, 'SEAT_TAKEN', { seat })
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

  // POST /api/tables/:tableId/terminate — host terminates the game (any phase)
  app.post('/api/tables/:tableId/terminate', async (req, res) => {
    const { tableId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const table = await getTable(redisClient, tableId)
      if (!table) return sendJSON(res, 404, { error: 'Table not found' })
      if (table.hostPlayerId !== session.playerId) {
        return sendJSON(res, 403, { error: 'Only the host can terminate the game' })
      }
      await terminateTable(redisClient, tableId)
      emitLobbyTableRemoved(wss, table)
      console.log('Game terminated by host:', { tableId, playerId: session.playerId })
      sendJSON(res, 200, { message: 'Game terminated.' })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      console.error('Terminate game error:', { tableId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables/:tableId/leave — leave a table (waiting: removes seat; in-progress: replaces with bot)
  app.post('/api/tables/:tableId/leave', async (req, res) => {
    const { tableId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const table = await getTable(redisClient, tableId)
      if (!table) return sendJSON(res, 404, { error: 'Table not found.' })

      if (table.status === 'playing') {
        const isObserver = (table.observers || []).includes(session.playerId)
        if (isObserver) {
          const leftResult = await leaveTable(redisClient, tableId, session.playerId)
          emitLobbyTableUpdated(wss, leftResult.table)
          if (wss) wss.broadcast(tableId, 'OBSERVER_LEFT', { playerId: session.playerId })
          console.log('Observer left in-progress table:', { tableId, playerId: session.playerId })
          return sendJSON(res, 200, { message: 'Left table.' })
        }
        const result = await leaveInProgressGame(redisClient, tableId, session.playerId)
        if (result.terminated) {
          emitLobbyTableRemoved(wss, table)
          console.log('Player left in-progress game, table terminated:', { tableId, playerId: session.playerId })
          return sendJSON(res, 200, { message: 'Left game. No human players remain — table terminated.' })
        }
        const gameState = await getGameState(redisClient, tableId)
        if (gameState) {
          const newState = substitutePlayerWithBot(gameState, result.seat)
          await saveGameState(redisClient, tableId, newState)
        }
        console.log('Player left in-progress game:', { tableId, playerId: session.playerId, seat: result.seat })
        return sendJSON(res, 200, { message: 'Left game. A bot has taken your place.' })
      }

      const leftResult = await leaveTable(redisClient, tableId, session.playerId)
      if (leftResult.wasObserver) {
        emitLobbyTableUpdated(wss, leftResult.table)
        if (wss) wss.broadcast(tableId, 'OBSERVER_LEFT', { playerId: session.playerId })
        console.log('Observer left table:', { tableId, playerId: session.playerId })
        return sendJSON(res, 200, { message: 'Left table.' })
      }
      if (leftResult.terminated) {
        emitLobbyTableRemoved(wss, table)
        console.log('Player left waiting table, table terminated:', { tableId, playerId: session.playerId })
        return sendJSON(res, 200, { message: 'Left table. No players remain — table deleted.' })
      }
      emitLobbyTableUpdated(wss, leftResult.table)
      if (wss) wss.broadcast(tableId, 'SEAT_VACATED', { seat: leftResult.seat })
      console.log('Player left table:', { tableId, playerId: session.playerId })
      sendJSON(res, 200, { message: 'Left table.' })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'NOT_SEATED') return sendJSON(res, 409, { error: err.message })
      console.error('Leave table error:', { tableId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables/:tableId/change-seat — move to a different empty seat (waiting only)
  app.post('/api/tables/:tableId/change-seat', async (req, res) => {
    const { tableId } = req.params
    const { seat } = req.body ?? {}
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const result = await changeSeat(redisClient, tableId, session.playerId, seat)
      if (result.oldSeat !== result.newSeat) {
        emitLobbyTableUpdated(wss, result.table)
        if (wss) {
          wss.broadcast(tableId, 'SEAT_VACATED', { seat: result.oldSeat })
          wss.broadcast(tableId, 'SEAT_TAKEN', { seat: result.newSeat })
        }
      }
      sendJSON(res, 200, { tableId, seat: result.newSeat })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'GAME_IN_PROGRESS') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'NOT_SEATED') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'SEAT_TAKEN') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'INVALID_SEAT') return sendJSON(res, 400, { error: err.message })
      if (err.code === 'CONCURRENT_MODIFICATION') return sendJSON(res, 503, { error: err.message })
      console.error('Change seat error:', { tableId, error: err.message })
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
      const isObserver = (table.observers || []).includes(session.playerId)
      if (!seat && !isObserver) return sendJSON(res, 403, { error: 'You are not at this table' })

      const db = getDb()
      const gameState = await getGameState(redisClient, tableId)
      const hostSeatWaiting = Object.entries(table.seats).find(([, pid]) => pid === table.hostPlayerId)?.[0] ?? null
      const enrichedObservers = await enrichObservers(db, table.observers || [])
      if (!gameState) {
        const enrichedSeats = await enrichSeats(db, table.seats)
        return sendJSON(res, 200, { status: 'waiting', seats: enrichedSeats, observers: enrichedObservers, isHost: table.hostPlayerId === session.playerId, hostSeat: hostSeatWaiting })
      }

      if (!seat) {
        const enrichedSeats = await enrichSeats(db, table.seats)
        const spectatorResponse = {
          status: 'spectating',
          seats: enrichedSeats,
          observers: enrichedObservers,
          isHost: false,
          hostSeat: hostSeatWaiting,
          ...(gameState ? getSpectatorView(gameState) : {}),
        }
        return sendJSON(res, 200, spectatorResponse)
      }

      const hostSeat = Object.entries(gameState.players).find(([, pid]) => pid === table.hostPlayerId)?.[0] ?? null
      const playerNames = await enrichSeats(db, gameState.players)
      sendJSON(res, 200, { ...getPlayerView(gameState, seat), playerNames, observers: enrichedObservers, isHost: table.hostPlayerId === session.playerId, hostSeat })
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
      if (gameState.waitingForReconnect) return sendJSON(res, 409, { error: 'Game is waiting for a player to reconnect' })

      validateBidTurn(gameState, seat)
      let newState = placeBid(gameState, seat, bid)
      if (wss) {
        const bidType = bid === 'nil' ? 'nil' : bid === 'blind_nil' ? 'blindNil' : 'number'
        const bidPayload = bidType === 'number' ? { seat, bidType, bid } : { seat, bidType }
        wss.broadcast(tableId, 'BID_PLACED', bidPayload)
        if (newState.phase === 'blind_nil_exchange') {
          emitBlindNilExchangePrompts(wss, newState)
        }
      }
      newState = advanceBotsWithEvents(newState, wss, tableId)
      await saveGameState(redisClient, tableId, newState)
      if (wss && newState.phase !== 'game_over') {
        wss.broadcast(tableId, 'TURN_CHANGED', { activeSeat: getActiveSeat(newState), phase: newState.phase })
      }
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
      if (wss && newState.phase === 'blind_nil_exchange') {
        emitBlindNilExchangePrompts(wss, newState)
      }
      newState = advanceBotsWithEvents(newState, wss, tableId)
      await saveGameState(redisClient, tableId, newState)
      if (wss && newState.phase !== 'game_over') {
        wss.broadcast(tableId, 'TURN_CHANGED', { activeSeat: getActiveSeat(newState), phase: newState.phase })
      }
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
      if (wss) {
        wss.sendToPlayer(session.playerId, 'HAND_REVEALED', { myHand: newState.hands[seat], seat })
      }
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
      if (gameState.waitingForReconnect) return sendJSON(res, 409, { error: 'Game is waiting for a player to reconnect' })

      validateCardPlay(gameState, seat, card)
      const prevCompletedLen = gameState.completedTricks.length
      const prevPhase = gameState.phase
      const trickWithCard = [...gameState.currentTrick, { seat, card }]
      let newState = playCard(gameState, seat, card)
      if (wss) {
        wss.broadcast(tableId, 'CARD_PLAYED', { seat, card, currentTrick: trickWithCard, nextPlayerSeat: newState.currentPlayerSeat, spadesBroken: newState.spadesbroken })
        // trickJustCompleted: tricks 1-12 AND 13th trick when game-over (length grows 12→13)
        const trickJustCompleted = newState.completedTricks.length > prevCompletedLen
        // handJustScored: phase left 'playing' — either new hand or game over
        const handJustScored = prevPhase === 'playing' && newState.phase !== 'playing'
        if (trickJustCompleted) {
          const trick = newState.completedTricks[newState.completedTricks.length - 1]
          wss.broadcast(tableId, 'TRICK_COMPLETE', { winnerSeat: trick.winner, plays: trick.plays, tricksWon: newState.tricksWon })
        } else if (handJustScored) {
          // New-hand 13th trick: completedTricks reset to [] so trickJustCompleted is false
          const lastEntry = newState.handHistory[newState.handHistory.length - 1]
          if (lastEntry?.lastTrick) {
            wss.broadcast(tableId, 'TRICK_COMPLETE', {
              winnerSeat: lastEntry.lastTrick.winner,
              plays: lastEntry.lastTrick.plays,
              tricksWon: lastEntry.tricksWon,
            })
          }
        }
        if (handJustScored) {
          emitHandComplete(wss, tableId, newState)
        }
      }
      newState = advanceBotsWithEvents(newState, wss, tableId)
      await saveGameState(redisClient, tableId, newState)
      if (wss && newState.phase !== 'game_over') {
        wss.broadcast(tableId, 'TURN_CHANGED', { activeSeat: getActiveSeat(newState), phase: newState.phase })
      }
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

  // POST /api/tables/:tableId/join-link — generate a shareable join link (host only)
  app.post('/api/tables/:tableId/join-link', async (req, res) => {
    const { tableId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const token = await createJoinLink(redisClient, tableId, session.playerId)
      const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
      const joinUrl = `${appUrl}/join/${token}`
      sendJSON(res, 200, { token, joinUrl })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'FORBIDDEN') return sendJSON(res, 403, { error: err.message })
      console.error('Create join link error:', { tableId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables/join-link/:token — use a join link to arrive and sit at a table
  app.post('/api/tables/join-link/:token', async (req, res) => {
    const { token } = req.params
    const { seat } = req.body ?? {}
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      // validateJoinLink verifies the token but does not consume it — consumed after successful seating
      const { tableId, key: tokenKey } = await validateJoinLink(redisClient, token)
      await markPlayerInvited(redisClient, tableId, session.playerId)
      const table = await sitAtTable(redisClient, tableId, session.playerId, seat)
      await redisClient.del(tokenKey)

      const actualSeat = Object.entries(table.seats).find(([, id]) => id === session.playerId)?.[0]

      if (isTableFull(table)) {
        const players = table.seats
        let gameState = createGame(tableId, players)
        gameState = advanceBotsWithEvents(gameState, wss, tableId)
        await saveGameState(redisClient, tableId, gameState)
        const playingTable = await markTablePlaying(redisClient, tableId, gameState.gameId)
        emitLobbyTableUpdated(wss, playingTable)
        if (wss) {
          wss.broadcast(tableId, 'GAME_STARTED', {})
          emitHandDealt(wss, gameState)
          wss.broadcast(tableId, 'TURN_CHANGED', { activeSeat: getActiveSeat(gameState), phase: gameState.phase })
        }
      } else {
        emitLobbyTableUpdated(wss, table)
        if (wss) wss.broadcast(tableId, 'SEAT_TAKEN', { seat: actualSeat })
      }

      sendJSON(res, 200, { tableId, seat: actualSeat })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'FORBIDDEN') return sendJSON(res, 403, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'GAME_IN_PROGRESS') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'SEAT_TAKEN') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'ALREADY_SEATED') return sendJSON(res, 409, { error: err.message })
      if (err.code === 'INVALID_SEAT') return sendJSON(res, 400, { error: err.message })
      console.error('Use join link error:', { token, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables/:tableId/spectator-link — generate a shareable spectator link (host only)
  app.post('/api/tables/:tableId/spectator-link', async (req, res) => {
    const { tableId } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const token = await createSpectatorLink(redisClient, tableId, session.playerId)
      const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
      const spectatorUrl = `${appUrl}/spectate/${token}`
      sendJSON(res, 200, { token, spectatorUrl })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'FORBIDDEN') return sendJSON(res, 403, { error: err.message })
      console.error('Create spectator link error:', { tableId, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // POST /api/tables/spectator-link/:token — use a spectator link to join as observer only
  app.post('/api/tables/spectator-link/:token', async (req, res) => {
    const { token } = req.params
    try {
      const redisClient = await getRedis()
      const session = await validateAuthHeaders(redisClient, req)
      const { tableId } = await validateSpectatorLink(redisClient, token)
      const table = await joinTable(redisClient, tableId, session.playerId, { asSpectator: true })
      emitLobbyTableUpdated(wss, table)
      if (wss) wss.broadcast(tableId, 'OBSERVER_JOINED', { playerId: session.playerId })
      sendJSON(res, 200, { tableId })
    } catch (err) {
      if (err.code === 'UNAUTHORIZED') return sendJSON(res, 401, { error: err.message })
      if (err.code === 'FORBIDDEN') return sendJSON(res, 403, { error: err.message })
      if (err.code === 'NOT_FOUND') return sendJSON(res, 404, { error: err.message })
      if (err.code === 'OBSERVERS_FULL') return sendJSON(res, 409, { error: err.message })
      console.error('Use spectator link error:', { token, error: err.message })
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  })

  // GET /api/build-info
  registerBuildInfoRoute(app)
}

/**
 * Register only the /api/build-info route on the given Express app.
 * This route has no dependencies (no Redis, no mailer, no DB) and can
 * be registered in isolation for lightweight testing.
 *
 * NOTE: This function does not apply CORS headers. When called via
 * handler(), CORS is handled by the global middleware registered in
 * app.js. If you use this function outside of handler(), you must add
 * CORS middleware yourself (see CLAUDE.md: "CORS headers are set
 * manually on every request — do not remove them").
 */
export function registerBuildInfoRoute(app) {
  // Guard against duplicate registration — skip if already registered
  if (app.locals._buildInfoRegistered) return
  app.locals._buildInfoRegistered = true

  app.get('/api/build-info', (req, res) => {
    // Check platform-specific env vars in priority order.
    // GIT_COMMIT_SHA is set by CI; VERCEL_GIT_COMMIT_SHA is set automatically
    // by Vercel; COMMIT_REF is set automatically by Netlify.
    const commitSha = process.env.GIT_COMMIT_SHA
      || process.env.VERCEL_GIT_COMMIT_SHA
      || process.env.COMMIT_REF
      || null
    const shortSha = commitSha ? commitSha.slice(0, 7) : null
    sendJSON(res, 200, { commitShort: shortSha })
  })
}
