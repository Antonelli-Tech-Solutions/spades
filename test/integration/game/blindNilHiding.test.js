/**
 * Integration tests: Blind Nil hand hiding flows.
 *
 * Requires a real Redis + DB instance (DATABASE_URL and REDIS_URL).
 * Tests are skipped when those env vars are absent.
 *
 * Setup: create a 4-player table, then inject game state with scores that
 * make the NS team eligible for Blind Nil (NS is 100+ points behind).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import bcrypt from 'bcryptjs'
import { handler } from '../../../server/server.js'
import { getDb, closeDb } from '../../../server/db.js'
import { getRedis, closeRedis } from '../../../server/redis.js'
import { getGameState, saveGameState } from '../../../server/lobby/table.js'

const skip =
  !process.env.DATABASE_URL || !process.env.REDIS_URL
    ? 'DATABASE_URL and REDIS_URL must both be set'
    : false

// ── Test server ───────────────────────────────────────────────────────────────

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

// ── DB helpers ────────────────────────────────────────────────────────────────

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
  await db.query(`DELETE FROM players WHERE email LIKE '%@bnh-itest.spades.invalid'`)
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

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function loginViaHttp(baseUrl, email, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return res.json()
}

// ── Game setup helper ─────────────────────────────────────────────────────────

/**
 * Create a table, seat all 4 players (north→south→east→west), and inject game
 * state so NS is eligible for Blind Nil (EW score = 100, NS score = 0).
 *
 * Returns { tableId, seatMap } where seatMap is seat → player credentials.
 */
async function setupEligibleGame(baseUrl, players) {
  const seats = ['north', 'east', 'south', 'west']
  const seatMap = {}
  for (let i = 0; i < 4; i++) {
    seatMap[seats[i]] = players[i]
  }

  const authHdrs = (player) => ({
    'Content-Type': 'application/json',
    'x-session-id': player.sessionId,
    'x-player-id': player.playerId,
  })

  // Create table
  const createRes = await fetch(`${baseUrl}/api/tables`, {
    method: 'POST',
    headers: authHdrs(players[0]),
  })
  assert.equal(createRes.status, 201)
  const { tableId } = await createRes.json()

  // Seat all players
  for (let i = 0; i < 4; i++) {
    const sitRes = await fetch(`${baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: authHdrs(players[i]),
      body: JSON.stringify({ seat: seats[i] }),
    })
    assert.equal(sitRes.status, 200, `player ${i + 1} (${seats[i]}) failed to sit`)
  }

  // Override game state so NS is eligible: EW = 100, NS = 0
  const redis = await getRedis()
  const gameState = await getGameState(redis, tableId)
  assert.ok(gameState, 'game state should exist after all 4 players sit')
  await saveGameState(redis, tableId, { ...gameState, scores: { ns: 0, ew: 100 } })

  return { tableId, seatMap }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Blind Nil hand hiding — integration', { skip }, () => {
  let server, db
  const players = []

  before(async () => {
    db = getDb()
    await getRedis()
    await ensurePlayersTable(db)

    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `bnh${i}@bnh-itest.spades.invalid`,
        username: `bnh_player${i}`,
        password: 'Password123!',
      })
    }

    server = await startTestServer()

    for (let i = 1; i <= 4; i++) {
      const data = await loginViaHttp(
        server.baseUrl,
        `bnh${i}@bnh-itest.spades.invalid`,
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

  it('eligible player hand is withheld on initial state fetch', { timeout: 10000 }, async () => {
    const { tableId, seatMap } = await setupEligibleGame(server.baseUrl, players)

    const northRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: {
        'x-session-id': seatMap.north.sessionId,
        'x-player-id': seatMap.north.playerId,
      },
    })
    assert.equal(northRes.status, 200)
    const northState = await northRes.json()

    assert.equal(northState.blindNilEligible, true, 'north should have blindNilEligible: true')
    assert.equal(northState.myHand, undefined, 'north myHand should be withheld')
  })

  it('ineligible team (EW) receives full hand immediately', { timeout: 10000 }, async () => {
    const { tableId, seatMap } = await setupEligibleGame(server.baseUrl, players)

    const eastRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: {
        'x-session-id': seatMap.east.sessionId,
        'x-player-id': seatMap.east.playerId,
      },
    })
    assert.equal(eastRes.status, 200)
    const eastState = await eastRes.json()

    assert.ok(Array.isArray(eastState.myHand), 'east should receive myHand')
    assert.equal(eastState.myHand.length, 13)
  })

  it('reveal-then-bid: eligible player reveals hand then bids normally', { timeout: 10000 }, async () => {
    const { tableId, seatMap } = await setupEligibleGame(server.baseUrl, players)

    const northHdrs = {
      'Content-Type': 'application/json',
      'x-session-id': seatMap.north.sessionId,
      'x-player-id': seatMap.north.playerId,
    }

    // Before reveal: hand is hidden
    const beforeRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: northHdrs,
    })
    const beforeState = await beforeRes.json()
    assert.equal(beforeState.myHand, undefined, 'hand must be hidden before reveal')

    // Call reveal-hand
    const revealRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/reveal-hand`, {
      method: 'POST',
      headers: northHdrs,
    })
    assert.equal(revealRes.status, 200, 'reveal-hand should succeed')
    const revealState = await revealRes.json()

    // HAND_REVEALED: myHand is now present
    assert.ok(Array.isArray(revealState.myHand), 'myHand should be present after reveal')
    assert.equal(revealState.myHand.length, 13)

    // Now north can bid normally — north is the last bidder (bidding order: east, south, west, north)
    // Need to drive the other three bids first
    const seats = ['east', 'south', 'west']
    let lastState = revealState
    for (const seat of seats) {
      const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': seatMap[seat].sessionId,
          'x-player-id': seatMap[seat].playerId,
        },
        body: JSON.stringify({ bid: 3 }),
      })
      assert.equal(res.status, 200, `${seat} bid should succeed`)
      lastState = await res.json()
    }

    // North bids a normal number (not blind nil)
    const northBidRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: northHdrs,
      body: JSON.stringify({ bid: 4 }),
    })
    assert.equal(northBidRes.status, 200, 'north normal bid should succeed after reveal')
    const afterBid = await northBidRes.json()
    assert.ok(
      afterBid.phase === 'playing' || afterBid.phase === 'blind_nil_exchange',
      `expected playing or blind_nil_exchange phase, got ${afterBid.phase}`,
    )
  })

  it('bid-blind-nil-directly: eligible player bids Blind Nil without revealing', { timeout: 10000 }, async () => {
    const { tableId, seatMap } = await setupEligibleGame(server.baseUrl, players)

    // Bidding order with north dealer: east, south, west, north
    // south is on NS (eligible). Bid east first, then south can bid blind_nil
    const eastBidRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': seatMap.east.sessionId,
        'x-player-id': seatMap.east.playerId,
      },
      body: JSON.stringify({ bid: 4 }),
    })
    assert.equal(eastBidRes.status, 200, 'east bid should succeed')

    // South bids blind_nil directly (no reveal-hand call)
    const southBidRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': seatMap.south.sessionId,
        'x-player-id': seatMap.south.playerId,
      },
      body: JSON.stringify({ bid: 'blind_nil' }),
    })
    assert.equal(southBidRes.status, 200, 'south blind nil bid should succeed')
    const southState = await southBidRes.json()
    // After bidding, south's view should NOT include myHand (they bid without seeing it)
    assert.equal(southState.myHand, undefined, 'south myHand should not be sent after blind nil bid')

    // Complete bidding: west and north still need to bid
    const westBidRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': seatMap.west.sessionId,
        'x-player-id': seatMap.west.playerId,
      },
      body: JSON.stringify({ bid: 3 }),
    })
    assert.equal(westBidRes.status, 200, 'west bid should succeed')

    const northBidRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': seatMap.north.sessionId,
        'x-player-id': seatMap.north.playerId,
      },
      body: JSON.stringify({ bid: 4 }),
    })
    assert.equal(northBidRes.status, 200, 'north bid should succeed')
    const finalState = await northBidRes.json()
    assert.equal(
      finalState.phase,
      'blind_nil_exchange',
      'game should enter blind_nil_exchange phase after blind nil bid',
    )
  })

  it('reveal-hand is rejected if player has already placed a bid', { timeout: 10000 }, async () => {
    const { tableId, seatMap } = await setupEligibleGame(server.baseUrl, players)

    // Inject a state where north has already bid (non-null) but phase is still 'bidding'
    // (simulates a scenario where north placed a bid before trying to reveal)
    const redis = await getRedis()
    const gameState = await getGameState(redis, tableId)
    const stateWithNorthBid = {
      ...gameState,
      bids: { ...gameState.bids, north: 4 },
      // Keep phase as 'bidding' — other players haven't bid yet
    }
    await saveGameState(redis, tableId, stateWithNorthBid)

    const revealRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/reveal-hand`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': seatMap.north.sessionId,
        'x-player-id': seatMap.north.playerId,
      },
    })
    assert.equal(revealRes.status, 409, 'reveal-hand should be rejected after bid placed')
    const body = await revealRes.json()
    assert.ok(body.error, 'error message should be present')
  })

  it('reveal-hand is rejected if player is not eligible', { timeout: 10000 }, async () => {
    // Create a fresh game with default scores (nobody eligible)
    const seats = ['north', 'east', 'south', 'west']
    const seatMap = {}
    for (let i = 0; i < 4; i++) {
      seatMap[seats[i]] = players[i]
    }
    const authHdrs = (player) => ({
      'Content-Type': 'application/json',
      'x-session-id': player.sessionId,
      'x-player-id': player.playerId,
    })

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: authHdrs(players[0]),
    })
    assert.equal(createRes.status, 201)
    const { tableId } = await createRes.json()

    for (let i = 0; i < 4; i++) {
      const sitRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
        method: 'POST',
        headers: authHdrs(players[i]),
        body: JSON.stringify({ seat: seats[i] }),
      })
      assert.equal(sitRes.status, 200)
    }

    // Scores are 0/0 — no one is eligible
    const revealRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/reveal-hand`, {
      method: 'POST',
      headers: authHdrs(seatMap.north),
    })
    assert.equal(revealRes.status, 400, 'reveal-hand should be rejected when player is not eligible')
    const body = await revealRes.json()
    assert.ok(body.error, 'error message should be present')
  })
})
