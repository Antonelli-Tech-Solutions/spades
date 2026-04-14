/**
 * Integration tests for the arrive-then-sit flow.
 * Covers all join policy paths: open, friends-only, invite-only.
 * Requires a real Redis instance (REDIS_URL) and database (DATABASE_URL).
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

const EMAIL_DOMAIN = '@garrsit.spades.invalid'

async function ensureTables(db) {
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
  await db.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      player_id UUID NOT NULL REFERENCES players(id),
      friend_id UUID NOT NULL REFERENCES players(id),
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(player_id, friend_id)
    )
  `)
  await db.query(`DELETE FROM friendships WHERE player_id IN (SELECT id FROM players WHERE email LIKE '%${EMAIL_DOMAIN}')`)
  await db.query(`DELETE FROM players WHERE email LIKE '%${EMAIL_DOMAIN}'`)
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

async function addFriendship(db, playerA, playerB) {
  await db.query(
    `INSERT INTO friendships (player_id, friend_id, status) VALUES ($1, $2, 'accepted')`,
    [playerA, playerB],
  )
}

describe('Arrive-then-Sit flow', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensureTables(db)

    const specs = [
      { email: `host${EMAIL_DOMAIN}`, username: 'arrsit_host', password: 'password123' },
      { email: `friend${EMAIL_DOMAIN}`, username: 'arrsit_friend', password: 'password123' },
      { email: `stranger${EMAIL_DOMAIN}`, username: 'arrsit_stranger', password: 'password123' },
      { email: `invited${EMAIL_DOMAIN}`, username: 'arrsit_invited', password: 'password123' },
    ]
    for (const spec of specs) {
      await insertVerifiedPlayer(db, spec)
    }
    server = await startTestServer()
    for (const spec of specs) {
      const session = await loginPlayer(server.baseUrl, spec.email, spec.password)
      players.push(session)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  // ── Arrive endpoint ──────────────────────────────────────────────────

  it('arrive places the player in observer state', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    assert.equal(createRes.status, 201)
    const { tableId } = await createRes.json()

    const arriveRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/arrive`, {
      method: 'POST',
      headers: { 'x-session-id': guest.sessionId, 'x-player-id': guest.playerId },
    })
    assert.equal(arriveRes.status, 200)
    const body = await arriveRes.json()
    assert.equal(body.tableId, tableId)

    const stateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
      headers: { 'x-session-id': guest.sessionId, 'x-player-id': guest.playerId },
    })
    const state = await stateRes.json()
    const observerIds = state.observers.map((o) => o.playerId)
    assert.ok(observerIds.includes(guest.playerId), 'guest should be an observer')
    const seatPlayerIds = Object.values(state.seats).map((s) => s?.playerId ?? s)
    assert.ok(!seatPlayerIds.includes(guest.playerId), 'guest should not be seated')
  })

  it('arrive returns 403 when spectating is disabled', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[1]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ spectating: false }),
    })
    const { tableId } = await createRes.json()

    const arriveRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/arrive`, {
      method: 'POST',
      headers: { 'x-session-id': guest.sessionId, 'x-player-id': guest.playerId },
    })
    assert.equal(arriveRes.status, 403)
  })

  // ── Open join policy ─────────────────────────────────────────────────

  it('open table: any observer can sit', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[2]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'public', joinPolicy: 'open' }),
    })
    const { tableId } = await createRes.json()

    await fetch(`${server.baseUrl}/api/tables/${tableId}/arrive`, {
      method: 'POST',
      headers: { 'x-session-id': guest.sessionId, 'x-player-id': guest.playerId },
    })

    const sitRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': guest.sessionId,
        'x-player-id': guest.playerId,
      },
      body: JSON.stringify({ seat: 'east' }),
    })
    assert.equal(sitRes.status, 200)
    const body = await sitRes.json()
    assert.equal(body.seat, 'east')
  })

  // ── Friends-only join policy ──────────────────────────────────────────

  it('friends-only table: friend of host can sit', { timeout: 10000 }, async () => {
    const host = players[0]
    const friend = players[1]

    await addFriendship(db, host.playerId, friend.playerId)

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'friends-only' }),
    })
    const { tableId } = await createRes.json()

    await fetch(`${server.baseUrl}/api/tables/${tableId}/arrive`, {
      method: 'POST',
      headers: { 'x-session-id': friend.sessionId, 'x-player-id': friend.playerId },
    })

    const sitRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': friend.sessionId,
        'x-player-id': friend.playerId,
      },
      body: JSON.stringify({ seat: 'east' }),
    })
    assert.equal(sitRes.status, 200)
  })

  it('friends-only table: non-friend gets 403 on sit', { timeout: 10000 }, async () => {
    const host = players[0]
    const stranger = players[2]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'public', joinPolicy: 'friends-only' }),
    })
    const { tableId } = await createRes.json()

    await fetch(`${server.baseUrl}/api/tables/${tableId}/arrive`, {
      method: 'POST',
      headers: { 'x-session-id': stranger.sessionId, 'x-player-id': stranger.playerId },
    })

    const sitRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': stranger.sessionId,
        'x-player-id': stranger.playerId,
      },
      body: JSON.stringify({ seat: 'east' }),
    })
    assert.equal(sitRes.status, 403)
  })

  // ── Invite-only join policy ───────────────────────────────────────────

  it('invite-only table: uninvited player gets 403 on sit', { timeout: 10000 }, async () => {
    const host = players[0]
    const stranger = players[2]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'private' }),
    })
    const { tableId } = await createRes.json()

    await fetch(`${server.baseUrl}/api/tables/${tableId}/arrive`, {
      method: 'POST',
      headers: { 'x-session-id': stranger.sessionId, 'x-player-id': stranger.playerId },
    })

    const sitRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': stranger.sessionId,
        'x-player-id': stranger.playerId,
      },
      body: JSON.stringify({ seat: 'east' }),
    })
    assert.equal(sitRes.status, 403)
  })

  it('invite-only table: player with join link can sit via join-link endpoint', { timeout: 10000 }, async () => {
    const host = players[0]
    const invited = players[3]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'private' }),
    })
    const { tableId } = await createRes.json()

    const linkRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/join-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    const { token } = await linkRes.json()

    const sitRes = await fetch(`${server.baseUrl}/api/tables/join-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': invited.sessionId,
        'x-player-id': invited.playerId,
      },
      body: JSON.stringify({ seat: 'east' }),
    })
    assert.equal(sitRes.status, 200)
    const body = await sitRes.json()
    assert.equal(body.seat, 'east')
  })

  it('invite-only table: directly invited player can sit', { timeout: 10000 }, async () => {
    const host = players[0]
    const invited = players[3]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'private' }),
    })
    const { tableId } = await createRes.json()

    const redisClient = await getRedis()
    const { markPlayerInvited } = await import('../../../server/lobby/table.js')
    await markPlayerInvited(redisClient, tableId, invited.playerId)

    await fetch(`${server.baseUrl}/api/tables/${tableId}/arrive`, {
      method: 'POST',
      headers: { 'x-session-id': invited.sessionId, 'x-player-id': invited.playerId },
    })

    const sitRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': invited.sessionId,
        'x-player-id': invited.playerId,
      },
      body: JSON.stringify({ seat: 'east' }),
    })
    assert.equal(sitRes.status, 200)
  })

  // ── Observer cannot bid or play ───────────────────────────────────────

  it('observer cannot place a bid', { timeout: 10000 }, async () => {
    const host = players[0]
    const observer = players[1]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    const { tableId } = await createRes.json()

    await fetch(`${server.baseUrl}/api/tables/${tableId}/arrive`, {
      method: 'POST',
      headers: { 'x-session-id': observer.sessionId, 'x-player-id': observer.playerId },
    })

    const bidRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': observer.sessionId,
        'x-player-id': observer.playerId,
      },
      body: JSON.stringify({ bid: 3 }),
    })
    assert.ok([400, 403, 404, 409].includes(bidRes.status), 'observer bid should be rejected')
  })

  // ── Arrive is idempotent ──────────────────────────────────────────────

  it('arriving twice is idempotent', { timeout: 10000 }, async () => {
    const host = players[0]
    const guest = players[2]

    const createRes = await fetch(`${server.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
    })
    const { tableId } = await createRes.json()

    const r1 = await fetch(`${server.baseUrl}/api/tables/${tableId}/arrive`, {
      method: 'POST',
      headers: { 'x-session-id': guest.sessionId, 'x-player-id': guest.playerId },
    })
    assert.equal(r1.status, 200)

    const r2 = await fetch(`${server.baseUrl}/api/tables/${tableId}/arrive`, {
      method: 'POST',
      headers: { 'x-session-id': guest.sessionId, 'x-player-id': guest.playerId },
    })
    assert.equal(r2.status, 200)
  })
})
