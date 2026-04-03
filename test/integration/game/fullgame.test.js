/**
 * End-to-end integration test: 4 players complete a full game of Spades.
 *
 * Flow:
 * 1. Register and log in 4 players (verified directly in the DB)
 * 2. Player 1 (north) creates a table; all 4 players sit
 * 3. Drive bidding, card play, and hand scoring until game_over
 * 4. Assert the final state has a valid winner and a met win/loss condition
 *
 * Bidding strategy: every player bids 6. The second bidder's number overrides
 * so the team bid is 6 for both teams. This typically yields +60 pts/hand with
 * minimal bags and ends the game in roughly 5 hands.
 *
 * Card-selection strategy: follow the led suit if possible; otherwise avoid
 * illegal spade leads (first trick / spades not yet broken).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import bcrypt from 'bcryptjs'
import { handler } from '../../../server/server.js'
import { getDb, closeDb } from '../../../server/db.js'
import { getRedis, closeRedis } from '../../../server/redis.js'

const skip =
  !process.env.DATABASE_URL || !process.env.REDIS_URL
    ? 'DATABASE_URL and REDIS_URL must both be set'
    : false

// ── Test server ──────────────────────────────────────────────────────────────

async function startTestServer() {
  const app = express()
  app.use(express.json())
  handler(app)
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      })
    })
  })
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function ensurePlayersTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS players (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE NOT NULL,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      is_verified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query(`DELETE FROM players WHERE email LIKE '%@e2etest.spades.invalid'`)
}

async function insertVerifiedPlayer(db, { email, username, password }) {
  const hash = await bcrypt.hash(password, 4)
  const result = await db.query(
    `INSERT INTO players (email, username, password_hash, is_verified)
     VALUES ($1, $2, $3, TRUE) RETURNING id`,
    [email, username, hash],
  )
  return result.rows[0].id
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function loginViaHttp(baseUrl, email, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return res.json()
}

// ── Game-logic helpers (mirror server rules for safe client-side decisions) ──

/** Returns the partner seat for a given seat. */
const PARTNER = { north: 'south', south: 'north', east: 'west', west: 'east' }
const getPartnerSeat = (seat) => PARTNER[seat]

/**
 * Pick a legal card from the player's hand given the current trick and state.
 *
 * Rules mirrored from server/game/trick.js getLegalPlays:
 * - When following: must follow the led suit if possible
 * - When leading on the first trick: cannot lead spades unless all spades
 * - When leading after first trick: cannot lead spades unless broken
 */
function pickLegalCard(hand, currentTrick, spadesbroken, isFirstTrick) {
  if (currentTrick.length > 0) {
    // Following — must follow led suit
    const ledSuit = currentTrick[0].card.suit
    const followers = hand.filter((c) => c.suit === ledSuit)
    if (followers.length > 0) return followers[0]

    // Can't follow suit — on first trick avoid spades if alternatives exist
    if (isFirstTrick) {
      const nonSpades = hand.filter((c) => c.suit !== 'spades')
      if (nonSpades.length > 0) return nonSpades[0]
    }

    return hand[0]
  }

  // Leading the trick — avoid spades when restricted
  if (isFirstTrick || !spadesbroken) {
    const nonSpades = hand.filter((c) => c.suit !== 'spades')
    if (nonSpades.length > 0) return nonSpades[0]
  }

  return hand[0]
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('E2E: 4 players complete a full game from table creation to game over', { skip }, () => {
  let server, db
  const players = [] // [{sessionId, playerId, username}, ...]

  before(async () => {
    db = getDb()
    await getRedis() // ensure redis is initialised
    await ensurePlayersTable(db)

    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `e2eplayer${i}@e2etest.spades.invalid`,
        username: `e2e_player${i}`,
        password: 'Password123!',
      })
    }

    server = await startTestServer()

    for (let i = 1; i <= 4; i++) {
      const data = await loginViaHttp(
        server.baseUrl,
        `e2eplayer${i}@e2etest.spades.invalid`,
        'Password123!',
      )
      players.push(data)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('4 players complete a full game from table creation to game over', async () => {
    const seats = ['north', 'east', 'south', 'west']

    // seat → player credentials
    const seatMap = {}
    for (let i = 0; i < 4; i++) {
      seatMap[seats[i]] = players[i]
    }

    const authHdrs = (player) => ({
      'Content-Type': 'application/json',
      'x-session-id': player.sessionId,
      'x-player-id': player.playerId,
    })

    // ── Step 1: Create table ────────────────────────────────────────────────
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: authHdrs(players[0]),
    })
    assert.equal(createRes.status, 201, 'table creation should succeed')
    const { tableId } = await createRes.json()
    assert.ok(tableId, 'should receive a tableId')

    // ── Step 2: All 4 players sit ───────────────────────────────────────────
    for (let i = 0; i < 4; i++) {
      const sitRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
        method: 'POST',
        headers: authHdrs(players[i]),
        body: JSON.stringify({ seat: seats[i] }),
      })
      assert.equal(sitRes.status, 200, `player ${i + 1} (${seats[i]}) failed to sit`)
    }

    // ── Step 3: Verify game started in bidding phase ────────────────────────
    const initRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: authHdrs(players[0]),
    })
    assert.equal(initRes.status, 200)
    let state = await initRes.json()
    assert.equal(state.phase, 'bidding', 'game should start in bidding phase')
    assert.equal(state.myHand.length, 13, 'north should have 13 cards')

    // ── Step 4: Drive the game to completion ────────────────────────────────

    // Helper closures
    const getState = async (seat) => {
      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
        headers: authHdrs(seatMap[seat]),
      })
      assert.equal(res.status, 200, `getState failed for seat ${seat}`)
      return res.json()
    }

    const placeBidHttp = async (seat, bidValue) => {
      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
        method: 'POST',
        headers: authHdrs(seatMap[seat]),
        body: JSON.stringify({ bid: bidValue }),
      })
      assert.equal(res.status, 200, `bid(${bidValue}) failed for ${seat}`)
      return res.json()
    }

    const playCardHttp = async (seat, card) => {
      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/play`, {
        method: 'POST',
        headers: authHdrs(seatMap[seat]),
        body: JSON.stringify({ card }),
      })
      assert.equal(
        res.status,
        200,
        `play failed for ${seat}: ${JSON.stringify(card)}`,
      )
      return res.json()
    }

    const exchangeHttp = async (seat, cards) => {
      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/blind-nil-exchange`, {
        method: 'POST',
        headers: authHdrs(seatMap[seat]),
        body: JSON.stringify({ cards }),
      })
      assert.equal(res.status, 200, `blind nil exchange failed for ${seat}`)
      return res.json()
    }

    const continueHttp = async (seat) => {
      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/continue`, {
        method: 'POST',
        headers: authHdrs(seatMap[seat]),
      })
      assert.equal(res.status, 200, `continue failed for ${seat}`)
      return res.json()
    }

    const MAX_HANDS = 40 // safety limit — game should end in ~5-10 hands
    let handsPlayed = 0

    while (handsPlayed < MAX_HANDS && state.phase !== 'game_over') {
      // ── Bidding ──────────────────────────────────────────────────────────
      while (state.phase === 'bidding') {
        const bidderSeat = state.currentBidderSeat
        // Bid 6: the second bidder's number becomes the team total.
        // Both teams targeting 6 of 13 tricks → reliable +60 pts/hand.
        state = await placeBidHttp(bidderSeat, 6)
      }

      if (state.phase === 'game_over') break

      // ── Blind nil exchange (if any) ───────────────────────────────────────
      while (state.phase === 'blind_nil_exchange') {
        const { currentBlindNilSeat, step } = state.blindNilExchange
        const actingSeat =
          step === 'blind_to_partner'
            ? currentBlindNilSeat
            : getPartnerSeat(currentBlindNilSeat)
        const actingState = await getState(actingSeat)
        // Send the first 2 cards from the acting player's hand
        const cards = actingState.myHand.slice(0, 2)
        state = await exchangeHttp(actingSeat, cards)
      }

      if (state.phase === 'game_over') break

      // ── Playing ───────────────────────────────────────────────────────────
      while (state.phase === 'playing') {
        const playerSeat = state.currentPlayerSeat
        const playerState = await getState(playerSeat)
        const card = pickLegalCard(
          playerState.myHand,
          playerState.currentTrick,
          playerState.spadesbroken,
          playerState.isFirstTrick,
        )
        state = await playCardHttp(playerSeat, card)
      }

      // ── Hand complete — dismiss summary to proceed ─────────────────────────
      if (state.phase === 'hand_complete') {
        // handSummary should be present
        assert.ok(state.handSummary, 'hand_complete state must include handSummary')
        assert.ok(state.handSummary.bids, 'handSummary must have bids')
        assert.ok('scoreDelta' in state.handSummary, 'handSummary must have scoreDelta')
        // Any seated player can dismiss; use north
        state = await continueHttp('north')
      }

      // A hand just completed — phase is now 'game_over' or 'bidding'
      handsPlayed++
    }

    // ── Step 5: Assertions ──────────────────────────────────────────────────
    assert.equal(state.phase, 'game_over', 'game must reach game_over state')
    assert.ok(
      state.winner === 'ns' || state.winner === 'ew',
      `winner must be 'ns' or 'ew', got: ${state.winner}`,
    )

    const loserTeam = state.winner === 'ns' ? 'ew' : 'ns'
    const winnerScore = state.scores[state.winner]
    const loserScore = state.scores[loserTeam]

    // Either the winner reached ≥250 or the loser dropped to ≤-250
    assert.ok(
      winnerScore >= 250 || loserScore <= -250,
      `win/loss condition not met — ns: ${state.scores.ns}, ew: ${state.scores.ew}`,
    )

    console.log('E2E game complete:', {
      hands: handsPlayed,
      winner: state.winner,
      scores: state.scores,
      bags: state.bags,
    })
  })
})
