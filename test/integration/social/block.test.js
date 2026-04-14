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
  await db.query(`
    CREATE TABLE IF NOT EXISTS player_blocks (
      id BIGSERIAL PRIMARY KEY,
      blocker_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      blocked_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(blocker_id, blocked_id)
    )
  `)
  await db.query(`DELETE FROM player_blocks WHERE blocker_id IN (
    SELECT id FROM players WHERE email LIKE '%@test.block.invalid'
  ) OR blocked_id IN (
    SELECT id FROM players WHERE email LIKE '%@test.block.invalid'
  )`)
  await db.query(`DELETE FROM friendships WHERE requester_id IN (
    SELECT id FROM players WHERE email LIKE '%@test.block.invalid'
  ) OR addressee_id IN (
    SELECT id FROM players WHERE email LIKE '%@test.block.invalid'
  )`)
  await db.query(`DELETE FROM players WHERE email LIKE '%@test.block.invalid'`)
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

describe('Block API', { skip }, () => {
  let server, db, redis
  let aliceId, bobId, charlieId
  let aliceHeaders, bobHeaders, charlieHeaders

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await resetTestSchema(db)
    server = await startTestServer(redis)

    aliceId = await insertTestPlayer(db, {
      email: 'alice_block@test.block.invalid',
      username: 'alice_block',
    })
    bobId = await insertTestPlayer(db, {
      email: 'bob_block@test.block.invalid',
      username: 'bob_block',
    })
    charlieId = await insertTestPlayer(db, {
      email: 'charlie_block@test.block.invalid',
      username: 'charlie_block',
    })

    aliceHeaders = await authHeaders(redis, { playerId: aliceId, email: 'alice_block@test.block.invalid', username: 'alice_block' })
    bobHeaders = await authHeaders(redis, { playerId: bobId, email: 'bob_block@test.block.invalid', username: 'bob_block' })
    charlieHeaders = await authHeaders(redis, { playerId: charlieId, email: 'charlie_block@test.block.invalid', username: 'charlie_block' })
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  describe('POST /api/players/:playerId/block', () => {
    it('blocks a player successfully', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/${bobId}/block`, {
        method: 'POST',
        headers: aliceHeaders,
      })
      assert.equal(res.status, 201)
      const body = await res.json()
      assert.ok(body.message)
    })

    it('is idempotent (blocking again does not error)', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/${bobId}/block`, {
        method: 'POST',
        headers: aliceHeaders,
      })
      assert.equal(res.status, 201)
    })

    it('returns 400 when blocking yourself', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/${aliceId}/block`, {
        method: 'POST',
        headers: aliceHeaders,
      })
      assert.equal(res.status, 400)
    })

    it('returns 404 for non-existent player', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/00000000-0000-4000-8000-000000000000/block`, {
        method: 'POST',
        headers: aliceHeaders,
      })
      assert.equal(res.status, 404)
    })

    it('returns 401 without auth headers', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/${bobId}/block`, {
        method: 'POST',
      })
      assert.equal(res.status, 401)
    })

    it('removes existing friendship when blocking', { timeout: 10000 }, async () => {
      // Make alice and charlie friends first
      await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: charlieId }),
      })
      await fetch(`${server.baseUrl}/api/friends/accept`, {
        method: 'POST',
        headers: charlieHeaders,
        body: JSON.stringify({ playerId: aliceId }),
      })

      // Verify they are friends
      let res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
      let body = await res.json()
      assert.ok(body.friends.find((f) => f.playerId === charlieId), 'should be friends before blocking')

      // Now block charlie
      res = await fetch(`${server.baseUrl}/api/players/${charlieId}/block`, {
        method: 'POST',
        headers: aliceHeaders,
      })
      assert.equal(res.status, 201)

      // Verify friendship is gone
      res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
      body = await res.json()
      assert.equal(body.friends.find((f) => f.playerId === charlieId), undefined, 'should not be friends after blocking')
    })
  })

  describe('GET /api/players/blocked', () => {
    it('returns the block list', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/blocked`, {
        headers: aliceHeaders,
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(Array.isArray(body.blocked))
      const bob = body.blocked.find((b) => b.playerId === bobId)
      assert.ok(bob, 'bob should be in block list')
      assert.equal(bob.username, 'bob_block')
      const charlie = body.blocked.find((b) => b.playerId === charlieId)
      assert.ok(charlie, 'charlie should be in block list')
    })

    it('returns 401 without auth headers', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/blocked`)
      assert.equal(res.status, 401)
    })
  })

  describe('Friend request rejection when blocked', () => {
    it('blocked player cannot send friend request to blocker (403)', { timeout: 10000 }, async () => {
      // Bob is blocked by Alice. Bob tries to send friend request to Alice.
      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: bobHeaders,
        body: JSON.stringify({ playerId: aliceId }),
      })
      assert.equal(res.status, 403)
    })

    it('blocker cannot send friend request to blocked player (403)', { timeout: 10000 }, async () => {
      // Alice blocked Bob. Alice tries to send friend request to Bob.
      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: bobId }),
      })
      assert.equal(res.status, 403)
    })
  })

  describe('DELETE /api/players/:playerId/block', () => {
    it('unblocks a player successfully', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/${bobId}/block`, {
        method: 'DELETE',
        headers: aliceHeaders,
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.ok(body.message)
    })

    it('returns 404 when block does not exist', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/players/${bobId}/block`, {
        method: 'DELETE',
        headers: aliceHeaders,
      })
      assert.equal(res.status, 404)
    })

    it('friend request works after unblock', { timeout: 10000 }, async () => {
      // Bob was unblocked by Alice. Bob can now send friend request.
      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: bobHeaders,
        body: JSON.stringify({ playerId: aliceId }),
      })
      assert.equal(res.status, 201)
    })
  })
})
