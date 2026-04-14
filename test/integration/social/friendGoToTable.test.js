import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { handler } from '../../../server/server.js'
import { getDb, closeDb } from '../../../server/db.js'
import { getRedis, closeRedis } from '../../../server/redis.js'
import { createSession } from '../../../server/auth/session.js'

const skip =
  !process.env.DATABASE_URL || !process.env.REDIS_URL
    ? 'DATABASE_URL and REDIS_URL must both be set'
    : false

async function startTestServer(redis) {
  const app = express()
  app.use(express.json())
  handler(app, { redis })
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

const EMAIL_DOMAIN = '@fgtt.spades.invalid'

async function resetTestSchema(db) {
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
      id BIGSERIAL PRIMARY KEY,
      requester_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      addressee_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(requester_id, addressee_id)
    )
  `)
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair_unique
    ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id))
  `)
  await db.query(`DELETE FROM friendships WHERE requester_id IN (
    SELECT id FROM players WHERE email LIKE $1
  ) OR addressee_id IN (
    SELECT id FROM players WHERE email LIKE $1
  )`, [`%${EMAIL_DOMAIN}`])
  await db.query(`DELETE FROM players WHERE email LIKE $1`, [`%${EMAIL_DOMAIN}`])
}

async function insertTestPlayer(db, { email, username }) {
  const result = await db.query(
    `INSERT INTO players (email, username, password_hash, is_verified)
     VALUES ($1, $2, 'hash', TRUE) RETURNING id`,
    [email, username],
  )
  return result.rows[0].id
}

async function authHeaders(redis, { playerId, email, username }) {
  const sessionId = await createSession(redis, { playerId, email, username })
  return {
    'Content-Type': 'application/json',
    'x-session-id': sessionId,
    'x-player-id': playerId,
  }
}

async function addFriendship(db, playerA, playerB) {
  await db.query(
    `INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'accepted')
     ON CONFLICT DO NOTHING`,
    [playerA, playerB],
  )
}

describe('Friend Go-to-Table', { skip }, () => {
  let server, db, redis
  let hostId, friendId, strangerId
  let hostHeaders, friendHeaders, strangerHeaders

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await resetTestSchema(db)
    server = await startTestServer(redis)

    hostId = await insertTestPlayer(db, { email: `host${EMAIL_DOMAIN}`, username: 'fgtt_host' })
    friendId = await insertTestPlayer(db, { email: `friend${EMAIL_DOMAIN}`, username: 'fgtt_friend' })
    strangerId = await insertTestPlayer(db, { email: `stranger${EMAIL_DOMAIN}`, username: 'fgtt_stranger' })

    hostHeaders = await authHeaders(redis, { playerId: hostId, email: `host${EMAIL_DOMAIN}`, username: 'fgtt_host' })
    friendHeaders = await authHeaders(redis, { playerId: friendId, email: `friend${EMAIL_DOMAIN}`, username: 'fgtt_friend' })
    strangerHeaders = await authHeaders(redis, { playerId: strangerId, email: `stranger${EMAIL_DOMAIN}`, username: 'fgtt_stranger' })

    await addFriendship(db, hostId, friendId)
    await addFriendship(db, friendId, strangerId)
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  // ── GET /api/friends/:friendId/table ────────────────────────────────────

  describe('GET /api/friends/:friendId/table', () => {
    it('returns null when friend is not at any table', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/${hostId}/table`, {
        headers: friendHeaders,
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.table, null)
    })

    it('returns table info when friend is at a public table', { timeout: 10000 }, async () => {
      const createRes = await fetch(`${server.baseUrl}/api/tables`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ visibility: 'public' }),
      })
      const { tableId } = await createRes.json()

      const res = await fetch(`${server.baseUrl}/api/friends/${hostId}/table`, {
        headers: friendHeaders,
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.table.tableId, tableId)
      assert.equal(body.canGoToTable, true)

      await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, {
        method: 'POST',
        headers: hostHeaders,
      })
    })

    it('returns table info for friends-only table when requester is friend of host', { timeout: 10000 }, async () => {
      const createRes = await fetch(`${server.baseUrl}/api/tables`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ visibility: 'friends-only' }),
      })
      const { tableId } = await createRes.json()

      const res = await fetch(`${server.baseUrl}/api/friends/${hostId}/table`, {
        headers: friendHeaders,
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.table.tableId, tableId)
      assert.equal(body.canGoToTable, true)

      await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, {
        method: 'POST',
        headers: hostHeaders,
      })
    })

    it('returns null for friends-only table when requester is not friend of host', { timeout: 10000 }, async () => {
      const createRes = await fetch(`${server.baseUrl}/api/tables`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ visibility: 'friends-only' }),
      })
      const { tableId } = await createRes.json()

      const res = await fetch(`${server.baseUrl}/api/friends/${hostId}/table`, {
        headers: strangerHeaders,
      })
      assert.equal(res.status, 403)

      await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, {
        method: 'POST',
        headers: hostHeaders,
      })
    })

    it('returns null for private table', { timeout: 10000 }, async () => {
      const createRes = await fetch(`${server.baseUrl}/api/tables`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ visibility: 'private' }),
      })
      const { tableId } = await createRes.json()

      const res = await fetch(`${server.baseUrl}/api/friends/${hostId}/table`, {
        headers: friendHeaders,
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.table, null)

      await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, {
        method: 'POST',
        headers: hostHeaders,
      })
    })

    it('returns canGoToTable=false when spectating is disabled and policy is invite-only', { timeout: 10000 }, async () => {
      const createRes = await fetch(`${server.baseUrl}/api/tables`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ visibility: 'public', joinPolicy: 'invite-only', spectating: false }),
      })
      const { tableId } = await createRes.json()

      const res = await fetch(`${server.baseUrl}/api/friends/${hostId}/table`, {
        headers: friendHeaders,
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.table.tableId, tableId)
      assert.equal(body.canGoToTable, false)

      await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, {
        method: 'POST',
        headers: hostHeaders,
      })
    })

    it('returns 403 when players are not friends', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/${strangerId}/table`, {
        headers: hostHeaders,
      })
      assert.equal(res.status, 403)
    })
  })

  // ── POST /api/friends/:friendId/go-to-table ────────────────────────────

  describe('POST /api/friends/:friendId/go-to-table', () => {
    it('arrives at friend public table as observer', { timeout: 10000 }, async () => {
      const createRes = await fetch(`${server.baseUrl}/api/tables`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ visibility: 'public' }),
      })
      const { tableId } = await createRes.json()

      const goRes = await fetch(`${server.baseUrl}/api/friends/${hostId}/go-to-table`, {
        method: 'POST',
        headers: friendHeaders,
      })
      assert.equal(goRes.status, 200)
      const body = await goRes.json()
      assert.equal(body.tableId, tableId)

      const stateRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/state`, {
        headers: friendHeaders,
      })
      const state = await stateRes.json()
      const observerIds = state.observers.map((o) => o.playerId)
      assert.ok(observerIds.includes(friendId), 'friend should be an observer')

      await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, { method: 'POST', headers: friendHeaders })
      await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, { method: 'POST', headers: hostHeaders })
    })

    it('arrives at friend friends-only table as observer', { timeout: 10000 }, async () => {
      const createRes = await fetch(`${server.baseUrl}/api/tables`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ visibility: 'friends-only' }),
      })
      const { tableId } = await createRes.json()

      const goRes = await fetch(`${server.baseUrl}/api/friends/${hostId}/go-to-table`, {
        method: 'POST',
        headers: friendHeaders,
      })
      assert.equal(goRes.status, 200)
      assert.equal((await goRes.json()).tableId, tableId)

      await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, { method: 'POST', headers: friendHeaders })
      await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, { method: 'POST', headers: hostHeaders })
    })

    it('returns 403 for private table', { timeout: 10000 }, async () => {
      const createRes = await fetch(`${server.baseUrl}/api/tables`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ visibility: 'private' }),
      })
      const { tableId } = await createRes.json()

      const goRes = await fetch(`${server.baseUrl}/api/friends/${hostId}/go-to-table`, {
        method: 'POST',
        headers: friendHeaders,
      })
      assert.equal(goRes.status, 403)

      await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, { method: 'POST', headers: hostHeaders })
    })

    it('returns 403 when spectating disabled and no seating rights', { timeout: 10000 }, async () => {
      const createRes = await fetch(`${server.baseUrl}/api/tables`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ visibility: 'public', joinPolicy: 'invite-only', spectating: false }),
      })
      const { tableId } = await createRes.json()

      const goRes = await fetch(`${server.baseUrl}/api/friends/${hostId}/go-to-table`, {
        method: 'POST',
        headers: friendHeaders,
      })
      assert.equal(goRes.status, 403)

      await fetch(`${server.baseUrl}/api/tables/${tableId}/leave`, { method: 'POST', headers: hostHeaders })
    })

    it('returns 403 when players are not friends', { timeout: 10000 }, async () => {
      const createRes = await fetch(`${server.baseUrl}/api/tables`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ visibility: 'public' }),
      })
      await createRes.json()

      const goRes = await fetch(`${server.baseUrl}/api/friends/${hostId}/go-to-table`, {
        method: 'POST',
        headers: strangerHeaders,
      })
      assert.equal(goRes.status, 403)
    })

    it('returns 404 when friend is not at a table', { timeout: 10000 }, async () => {
      const goRes = await fetch(`${server.baseUrl}/api/friends/${strangerId}/go-to-table`, {
        method: 'POST',
        headers: friendHeaders,
      })
      assert.equal(goRes.status, 404)
    })
  })
})
