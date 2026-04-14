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
    SELECT id FROM players WHERE email LIKE '%@test.spades.invalid'
  ) OR addressee_id IN (
    SELECT id FROM players WHERE email LIKE '%@test.spades.invalid'
  )`)
  await db.query(`DELETE FROM players WHERE email LIKE '%@test.spades.invalid'`)
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

describe('Friends API', { skip }, () => {
  let server, db, redis
  let aliceId, bobId, charlieId
  let aliceHeaders, bobHeaders, charlieHeaders

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await resetTestSchema(db)
    server = await startTestServer(redis)

    aliceId = await insertTestPlayer(db, {
      email: 'alice_friends@test.spades.invalid',
      username: 'alice_friends',
    })
    bobId = await insertTestPlayer(db, {
      email: 'bob_friends@test.spades.invalid',
      username: 'bob_friends',
    })
    charlieId = await insertTestPlayer(db, {
      email: 'charlie_friends@test.spades.invalid',
      username: 'charlie_friends',
    })

    aliceHeaders = await authHeaders(redis, { playerId: aliceId, email: 'alice_friends@test.spades.invalid', username: 'alice_friends' })
    bobHeaders = await authHeaders(redis, { playerId: bobId, email: 'bob_friends@test.spades.invalid', username: 'bob_friends' })
    charlieHeaders = await authHeaders(redis, { playerId: charlieId, email: 'charlie_friends@test.spades.invalid', username: 'charlie_friends' })
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  describe('GET /api/players/search', () => {
    it('returns matching players by username prefix', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/search?username=alice`, {
        headers: aliceHeaders,
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.players))
    })

    it('does not return the requesting player in search results', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/search?username=alice_friends`, {
        headers: aliceHeaders,
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      const selfResult = body.players.find((p) => p.playerId === aliceId)
      assert.equal(selfResult, undefined, 'should not include self in results')
    })

    it('returns 400 when username query is missing', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/search`, {
        headers: aliceHeaders,
      })
      assert.equal(res.status, 400)
    })

    it('returns 401 without auth headers', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/search?username=alice`)
      assert.equal(res.status, 401)
    })
  })

  describe('POST /api/friends/request', () => {
    it('sends a friend request successfully', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: bobId }),
      })
      assert.equal(res.status, 201)
      const body = await res.json()
      assert.ok(body.message)
    })

    it('returns 409 for duplicate friend request', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: bobId }),
      })
      assert.equal(res.status, 409)
    })

    it('returns 400 when sending request to yourself', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: aliceId }),
      })
      assert.equal(res.status, 400)
    })

    it('returns 404 for non-existent player', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: '00000000-0000-4000-8000-000000000000' }),
      })
      assert.equal(res.status, 404)
    })
  })

  describe('POST /api/friends/accept', () => {
    it('accepts a pending friend request', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/accept`, {
        method: 'POST',
        headers: bobHeaders,
        body: JSON.stringify({ playerId: aliceId }),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.message)
    })

    it('returns 404 when no pending request exists', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/accept`, {
        method: 'POST',
        headers: bobHeaders,
        body: JSON.stringify({ playerId: aliceId }),
      })
      assert.equal(res.status, 404)
    })
  })

  describe('GET /api/friends', () => {
    it('returns friends list with accepted friendships', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends`, {
        headers: aliceHeaders,
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.friends))
      assert.ok(body.friends.length >= 1, 'should have at least one friend')
      const bob = body.friends.find((f) => f.playerId === bobId)
      assert.ok(bob, 'alice should have bob as a friend')
      assert.equal(bob.username, 'bob_friends')
    })

    it('returns pending requests', { timeout: 10000 }, async () => {
      await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: charlieHeaders,
        body: JSON.stringify({ playerId: aliceId }),
      })

      const res = await fetch(`${server.baseUrl}/api/friends`, {
        headers: aliceHeaders,
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.pending))
      const charlieReq = body.pending.find((p) => p.playerId === charlieId)
      assert.ok(charlieReq, 'should have pending request from charlie')
    })
  })

  describe('POST /api/friends/decline', () => {
    it('declines a pending friend request', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/decline`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: charlieId }),
      })
      assert.equal(res.status, 200)
    })

    it('returns 404 when no pending request exists', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/decline`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: charlieId }),
      })
      assert.equal(res.status, 404)
    })
  })

  describe('DELETE /api/friends/:playerId', () => {
    it('removes an accepted friend', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/${bobId}`, {
        method: 'DELETE',
        headers: aliceHeaders,
      })
      assert.equal(res.status, 200)
    })

    it('returns 404 when friendship does not exist', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/${bobId}`, {
        method: 'DELETE',
        headers: aliceHeaders,
      })
      assert.equal(res.status, 404)
    })

    it('friends list is empty after removal', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends`, {
        headers: aliceHeaders,
      })
      const body = await res.json()
      const bob = body.friends.find((f) => f.playerId === bobId)
      assert.equal(bob, undefined, 'bob should no longer be in friends list')
    })
  })
})
