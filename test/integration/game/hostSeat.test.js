/**
 * Integration tests verifying that GET /api/tables/:tableId/state
 * includes the `hostSeat` field so clients can render a host indicator
 * next to any player's seat box (not just for the host themselves).
 *
 * Requires a real Redis instance (REDIS_URL) and database (DATABASE_URL).
 * Tests are skipped when either is not set.
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@hstest.spades.invalid'`)
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

async function createTableApi(baseUrl, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
  })
  return res.json()
}

async function sitAtTable(baseUrl, tableId, seat, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/sit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-id': sessionId, 'x-player-id': playerId },
    body: JSON.stringify({ seat }),
  })
  return res.json()
}

async function getGameStateApi(baseUrl, tableId, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/state`, {
    headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
  })
  return res.json()
}

describe('GET /api/tables/:tableId/state — hostSeat field', { skip }, () => {
  let server, db, redis

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `hs_player${i}@hstest.spades.invalid`,
        username: `hstest_player${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('includes hostSeat in the waiting state response', { timeout: 10000 }, async () => {
    const { sessionId, playerId } = await loginPlayer(
      server.baseUrl,
      'hs_player1@hstest.spades.invalid',
      'password123',
    )
    const { tableId } = await createTableApi(server.baseUrl, sessionId, playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', sessionId, playerId)

    const state = await getGameStateApi(server.baseUrl, tableId, sessionId, playerId)

    assert.equal(state.status, 'waiting')
    assert.ok('hostSeat' in state, 'state should include hostSeat')
    assert.equal(state.hostSeat, 'north', 'host seated at north should have hostSeat === "north"')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('includes hostSeat for a non-host player in the waiting state', { timeout: 10000 }, async () => {
    const host = await loginPlayer(server.baseUrl, 'hs_player1@hstest.spades.invalid', 'password123')
    const guest = await loginPlayer(server.baseUrl, 'hs_player2@hstest.spades.invalid', 'password123')

    const { tableId } = await createTableApi(server.baseUrl, host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'north', host.sessionId, host.playerId)
    await sitAtTable(server.baseUrl, tableId, 'south', guest.sessionId, guest.playerId)

    // Guest (non-host) fetches the state
    const state = await getGameStateApi(server.baseUrl, tableId, guest.sessionId, guest.playerId)

    assert.equal(state.status, 'waiting')
    assert.ok('hostSeat' in state, 'state should include hostSeat for non-host players too')
    assert.equal(state.hostSeat, 'north', 'host is at north regardless of who is asking')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('includes hostSeat in the in-game state response', { timeout: 10000 }, async () => {
    const players = []
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(server.baseUrl, `hs_player${i}@hstest.spades.invalid`, 'password123')
      players.push(data)
    }

    const { tableId } = await createTableApi(server.baseUrl, players[0].sessionId, players[0].playerId)
    const seats = ['north', 'east', 'south', 'west']
    for (let i = 0; i < 4; i++) {
      await sitAtTable(server.baseUrl, tableId, seats[i], players[i].sessionId, players[i].playerId)
    }

    // All seated — game should have started
    const state = await getGameStateApi(server.baseUrl, tableId, players[0].sessionId, players[0].playerId)

    assert.ok('hostSeat' in state, 'in-game state should include hostSeat')
    // Player 0 (host) sat at north
    assert.equal(state.hostSeat, 'north', 'host sat at north, so hostSeat should be "north"')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.del(`game:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('hostSeat is null when host has not yet taken a seat', { timeout: 10000 }, async () => {
    const { sessionId, playerId } = await loginPlayer(
      server.baseUrl,
      'hs_player1@hstest.spades.invalid',
      'password123',
    )
    const { tableId } = await createTableApi(server.baseUrl, sessionId, playerId)
    // Seat a different player (not the host) so we can query the state
    const guest = await loginPlayer(server.baseUrl, 'hs_player2@hstest.spades.invalid', 'password123')
    await sitAtTable(server.baseUrl, tableId, 'east', guest.sessionId, guest.playerId)

    // Host hasn't sat yet — but we can only query if seated. Seat the host too.
    await sitAtTable(server.baseUrl, tableId, 'south', sessionId, playerId)

    const state = await getGameStateApi(server.baseUrl, tableId, sessionId, playerId)
    // Host is at south
    assert.equal(state.hostSeat, 'south')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })
})
