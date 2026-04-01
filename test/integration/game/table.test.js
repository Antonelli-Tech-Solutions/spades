/**
 * Integration tests for table creation and seat management.
 * Requires a real Redis instance (REDIS_URL).
 * Tests are skipped when REDIS_URL is not set.
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@gtest.spades.invalid'`)
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

async function loginPlayer(baseUrl, email, password) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return res.json()
}

describe('POST /api/tables', { skip }, () => {
  let server, db, redis

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    await insertVerifiedPlayer(db, {
      email: 'host@gtest.spades.invalid',
      username: 'gtest_host',
      password: 'password123',
    })
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('creates a table and returns tableId for authenticated player', async () => {
    const { sessionId, playerId } = await loginPlayer(
      server.baseUrl,
      'host@gtest.spades.invalid',
      'password123',
    )
    const res = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.ok(body.tableId, 'should return a tableId')
  })

  it('returns 401 without auth headers', async () => {
    const res = await fetch(`${server.baseUrl}/api/tables`, { method: 'POST' })
    assert.equal(res.status, 401)
  })
})

describe('POST /api/tables/:tableId/sit', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `sitplayer${i}@gtest.spades.invalid`,
        username: `gtest_sit${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    // Login all 4 players
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `sitplayer${i}@gtest.spades.invalid`,
        'password123',
      )
      players.push(data)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('4 players can sit and game starts automatically', async () => {
    // Host creates table
    const { sessionId, playerId } = players[0]
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    const { tableId } = await createRes.json()

    const seats = ['north', 'east', 'south', 'west']
    for (let i = 0; i < 4; i++) {
      const p = players[i]
      const sitRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': p.sessionId,
          'x-player-id': p.playerId,
        },
        body: JSON.stringify({ seat: seats[i] }),
      })
      assert.equal(sitRes.status, 200, `player ${i + 1} sit failed`)
    }

    // Check game state is now available
    const stateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: { 'x-session-id': players[0].sessionId, 'x-player-id': players[0].playerId },
    })
    assert.equal(stateRes.status, 200)
    const state = await stateRes.json()
    assert.equal(state.phase, 'bidding', 'game should be in bidding phase after all players sit')
    assert.equal(state.myHand.length, 13, 'player should have 13 cards')
  })

  it('game does not start until all 4 seats are filled', async () => {
    const { sessionId, playerId } = players[0]
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    const { tableId } = await createRes.json()

    const seats = ['north', 'east', 'south']
    for (let i = 0; i < 3; i++) {
      const p = players[i]
      const sitRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': p.sessionId,
          'x-player-id': p.playerId,
        },
        body: JSON.stringify({ seat: seats[i] }),
      })
      assert.equal(sitRes.status, 200, `player ${i + 1} sit failed`)

      // After each of the first 3 players sits, game should still be waiting
      const stateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
        headers: { 'x-session-id': p.sessionId, 'x-player-id': p.playerId },
      })
      assert.equal(stateRes.status, 200)
      const state = await stateRes.json()
      assert.equal(state.status, 'waiting', `game should still be waiting after ${i + 1} player(s) seated`)
      assert.equal(state.phase, undefined, 'game phase should not be set before all seats are filled')
    }
  })

  it('returns 409 when seat is already taken', async () => {
    const { sessionId, playerId } = players[0]
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    const { tableId } = await createRes.json()

    // Sit player 0 at north
    await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[0].sessionId,
        'x-player-id': players[0].playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })

    // Try to sit player 1 at north too
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[1].sessionId,
        'x-player-id': players[1].playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })
    assert.equal(res.status, 409)
  })

  it('returns 400 for an invalid seat name', async () => {
    const { sessionId, playerId } = players[0]
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    const { tableId } = await createRes.json()

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
        'x-player-id': playerId,
      },
      body: JSON.stringify({ seat: 'invalid' }),
    })
    assert.equal(res.status, 400)
  })

  it('returns 409 when player is already seated at this table', async () => {
    const { sessionId, playerId } = players[0]
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    const { tableId } = await createRes.json()

    // Sit player 0 at north
    await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[0].sessionId,
        'x-player-id': players[0].playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })

    // Same player tries to sit at east
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[0].sessionId,
        'x-player-id': players[0].playerId,
      },
      body: JSON.stringify({ seat: 'east' }),
    })
    assert.equal(res.status, 409)
  })

  it('returns 404 for a non-existent table', async () => {
    const { sessionId, playerId } = players[0]
    const res = await fetch(`${server.baseUrl}/api/tables/00000000-0000-0000-0000-000000000000/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
        'x-player-id': playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })
    assert.equal(res.status, 404)
  })

  it('GET /api/tables/:tableId/state returns 403 when player is not seated', async () => {
    const { sessionId, playerId } = players[0]
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    const { tableId } = await createRes.json()

    // players[3] is not seated at this table
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: {
        'x-session-id': players[3].sessionId,
        'x-player-id': players[3].playerId,
      },
    })
    assert.equal(res.status, 403)
  })
})

describe('POST /api/tables/:tableId/bid', { skip }, () => {
  let server, db, redis
  const players = []
  let tableId

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `bidplayer${i}@gtest.spades.invalid`,
        username: `gtest_bid${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `bidplayer${i}@gtest.spades.invalid`,
        'password123',
      )
      players.push(data)
    }

    // Set up a table with 4 players
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': players[0].sessionId, 'x-player-id': players[0].playerId },
    })
    const body = await createRes.json()
    tableId = body.tableId

    const seats = ['north', 'east', 'south', 'west']
    for (let i = 0; i < 4; i++) {
      await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': players[i].sessionId,
          'x-player-id': players[i].playerId,
        },
        body: JSON.stringify({ seat: seats[i] }),
      })
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('east player bids first (left of north dealer)', async () => {
    // players[1] is east (second player seated)
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[1].sessionId,
        'x-player-id': players[1].playerId,
      },
      body: JSON.stringify({ bid: 3 }),
    })
    assert.equal(res.status, 200)
    const state = await res.json()
    assert.equal(state.bids.east, 3)
    assert.equal(state.currentBidderSeat, 'south')
  })

  it('returns 409 when wrong player tries to bid', async () => {
    // players[0] is north — but it should be south's turn now
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[0].sessionId,
        'x-player-id': players[0].playerId,
      },
      body: JSON.stringify({ bid: 4 }),
    })
    assert.equal(res.status, 409)
  })

  it('returns 400 for an invalid bid value', async () => {
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[2].sessionId,
        'x-player-id': players[2].playerId,
      },
      body: JSON.stringify({ bid: 14 }),
    })
    assert.equal(res.status, 400)
  })

  it('returns 400 when bidding blind nil without eligibility (team not 100+ behind)', async () => {
    // Scores start at 0-0; NS is not 100+ behind
    // players[1] is east — that's the current bidder
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[1].sessionId,
        'x-player-id': players[1].playerId,
      },
      body: JSON.stringify({ bid: 'blind_nil' }),
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.ok(body.error, 'should return an error message')
  })
})

describe('GET /api/tables', { skip }, () => {
  let server, db, redis

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    await insertVerifiedPlayer(db, {
      email: 'listhost@gtest.spades.invalid',
      username: 'gtest_listhost',
      password: 'password123',
    })
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('returns 401 without auth headers', async () => {
    const res = await fetch(`${server.baseUrl}/api/tables`)
    assert.equal(res.status, 401)
  })

  it('returns 200 with tables array when authenticated', async () => {
    const { sessionId, playerId } = await loginPlayer(
      server.baseUrl,
      'listhost@gtest.spades.invalid',
      'password123',
    )
    const res = await fetch(`${server.baseUrl}/api/tables`, {
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.tables), 'should return a tables array')
  })

  it('includes newly created waiting tables in the list', async () => {
    const { sessionId, playerId } = await loginPlayer(
      server.baseUrl,
      'listhost@gtest.spades.invalid',
      'password123',
    )
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': sessionId,
        'x-player-id': playerId,
      },
      body: JSON.stringify({ name: 'Test List Table' }),
    })
    const { tableId } = await createRes.json()

    const listRes = await fetch(`${server.baseUrl}/api/tables`, {
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    assert.equal(listRes.status, 200)
    const body = await listRes.json()
    const found = body.tables.find((t) => t.tableId === tableId)
    assert.ok(found, 'newly created table should appear in list')
    assert.equal(found.name, 'Test List Table')
    assert.ok(found.seats, 'table entry should include seats')
    assert.equal(found.seatsAvailable, 4)
  })

  it('does not include tables that are already playing', async () => {
    const players = []
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `listplay${i}@gtest.spades.invalid`,
        username: `gtest_listplay${i}`,
        password: 'password123',
      })
    }
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `listplay${i}@gtest.spades.invalid`,
        'password123',
      )
      players.push(data)
    }

    // Create a table and fill all seats (triggers game start)
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': players[0].sessionId, 'x-player-id': players[0].playerId },
    })
    const { tableId } = await createRes.json()

    const seats = ['north', 'east', 'south', 'west']
    for (let i = 0; i < 4; i++) {
      await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': players[i].sessionId,
          'x-player-id': players[i].playerId,
        },
        body: JSON.stringify({ seat: seats[i] }),
      })
    }

    const listRes = await fetch(`${server.baseUrl}/api/tables`, {
      headers: { 'x-session-id': players[0].sessionId, 'x-player-id': players[0].playerId },
    })
    const body = await listRes.json()
    const found = body.tables.find((t) => t.tableId === tableId)
    assert.equal(found, undefined, 'playing table should not appear in list')
  })
})

describe('POST /api/tables/:tableId/blind-nil-exchange', { skip }, () => {
  let server, db, redis
  const players = []
  let tableId

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `bnilplayer${i}@gtest.spades.invalid`,
        username: `gtest_bnil${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `bnilplayer${i}@gtest.spades.invalid`,
        'password123',
      )
      players.push(data)
    }

    // Create table and seat all 4 players (north=players[0], east=players[1], south=players[2], west=players[3])
    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: { 'x-session-id': players[0].sessionId, 'x-player-id': players[0].playerId },
    })
    const body = await createRes.json()
    tableId = body.tableId

    const seats = ['north', 'east', 'south', 'west']
    for (let i = 0; i < 4; i++) {
      await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': players[i].sessionId,
          'x-player-id': players[i].playerId,
        },
        body: JSON.stringify({ seat: seats[i] }),
      })
    }

    // Manipulate game state so NS (players[0]=north, players[2]=south) is 100+ behind EW
    const gameStateRaw = await redis.get(`game:${tableId}`)
    const gameState = JSON.parse(gameStateRaw)
    gameState.scores = { ns: 0, ew: 100 }
    await redis.set(`game:${tableId}`, JSON.stringify(gameState), { EX: 3600 })
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  // Helper: bid all 4 players to reach blind_nil_exchange phase
  // North deals → bidding order: east, south, west, north
  // south (NS first bidder) bids blind_nil; scores were set to ns=0, ew=100 above
  async function bidToBlindNilExchange() {
    // east bids
    await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[1].sessionId,
        'x-player-id': players[1].playerId,
      },
      body: JSON.stringify({ bid: 3 }),
    })
    // south bids blind_nil (eligible: ns=0, ew=100 → 100 pts behind)
    await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[2].sessionId,
        'x-player-id': players[2].playerId,
      },
      body: JSON.stringify({ bid: 'blind_nil' }),
    })
    // west bids
    await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[3].sessionId,
        'x-player-id': players[3].playerId,
      },
      body: JSON.stringify({ bid: 3 }),
    })
    // north bids (NS second bidder — sets team total)
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[0].sessionId,
        'x-player-id': players[0].playerId,
      },
      body: JSON.stringify({ bid: 5 }),
    })
    return res.json()
  }

  it('transitions to blind_nil_exchange phase after all bids when a player bids blind nil', async () => {
    const state = await bidToBlindNilExchange()
    assert.equal(state.phase, 'blind_nil_exchange')
    assert.equal(state.bids.south, 'blind_nil')
  })

  it('blind nil player sends 2 cards to partner, then partner sends 2 back — phase becomes playing', async () => {
    // Get south's hand (blind nil player)
    const southStateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: { 'x-session-id': players[2].sessionId, 'x-player-id': players[2].playerId },
    })
    const southState = await southStateRes.json()
    const southCards = southState.myHand.slice(0, 2)

    // Step 1: south sends 2 cards to north
    const step1Res = await fetch(`${server.baseUrl}/api/tables/${tableId}/blind-nil-exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[2].sessionId,
        'x-player-id': players[2].playerId,
      },
      body: JSON.stringify({ cards: southCards }),
    })
    assert.equal(step1Res.status, 200)

    // Get north's hand (partner)
    const northStateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: { 'x-session-id': players[0].sessionId, 'x-player-id': players[0].playerId },
    })
    const northState = await northStateRes.json()
    // North has 13 original cards; pick 2 to send back
    const northCards = northState.myHand.slice(0, 2)

    // Step 2: north sends 2 cards back to south
    const step2Res = await fetch(`${server.baseUrl}/api/tables/${tableId}/blind-nil-exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[0].sessionId,
        'x-player-id': players[0].playerId,
      },
      body: JSON.stringify({ cards: northCards }),
    })
    assert.equal(step2Res.status, 200)
    const finalState = await step2Res.json()
    assert.equal(finalState.phase, 'playing', 'game should transition to playing after full exchange')
  })

  it('returns 400 when wrong player tries to submit exchange', async () => {
    // After the exchange above, game is in 'playing'. We need a fresh game state in
    // blind_nil_exchange phase for this test. Re-set the game state in Redis directly.
    const gameStateRaw = await redis.get(`game:${tableId}`)
    const gameState = JSON.parse(gameStateRaw)
    // Simulate returning to blind_nil_exchange (south tries again)
    const injectedState = {
      ...gameState,
      phase: 'blind_nil_exchange',
      bids: { ...gameState.bids, south: 'blind_nil' },
      blindNilExchange: {
        pending: ['south'],
        currentBlindNilSeat: 'south',
        step: 'blind_to_partner',
        cardsFromBlind: null,
      },
    }
    await redis.set(`game:${tableId}`, JSON.stringify(injectedState), { EX: 3600 })

    // north tries to send cards first (wrong — south must go first)
    const northStateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: { 'x-session-id': players[0].sessionId, 'x-player-id': players[0].playerId },
    })
    const northState = await northStateRes.json()
    const northCards = northState.myHand.slice(0, 2)

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/blind-nil-exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[0].sessionId,
        'x-player-id': players[0].playerId,
      },
      body: JSON.stringify({ cards: northCards }),
    })
    assert.equal(res.status, 400)
  })

  it('returns 400 when submitting wrong number of cards (not 2)', async () => {
    // Get south's current hand
    const southStateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: { 'x-session-id': players[2].sessionId, 'x-player-id': players[2].playerId },
    })
    const southState = await southStateRes.json()
    const oneCard = southState.myHand.slice(0, 1)

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/blind-nil-exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': players[2].sessionId,
        'x-player-id': players[2].playerId,
      },
      body: JSON.stringify({ cards: oneCard }),
    })
    assert.equal(res.status, 400)
  })
})
