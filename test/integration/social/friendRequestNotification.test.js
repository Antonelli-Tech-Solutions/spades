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
  await db.query(`DELETE FROM friendships WHERE requester_id IN (
    SELECT id FROM players WHERE email LIKE '%@test.notify.spades.invalid'
  ) OR addressee_id IN (
    SELECT id FROM players WHERE email LIKE '%@test.notify.spades.invalid'
  )`)
  await db.query(`DELETE FROM player_blocks WHERE blocker_id IN (
    SELECT id FROM players WHERE email LIKE '%@test.notify.spades.invalid'
  ) OR blocked_id IN (
    SELECT id FROM players WHERE email LIKE '%@test.notify.spades.invalid'
  )`)
  await db.query(`DELETE FROM players WHERE email LIKE '%@test.notify.spades.invalid'`)
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

describe('Friend Request Notifications', { skip }, () => {
  let server, db, redis
  let aliceId, bobId, charlieId, daveId
  let aliceHeaders, bobHeaders, charlieHeaders, daveHeaders

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await resetTestSchema(db)
    server = await startTestServer(redis)

    aliceId = await insertTestPlayer(db, {
      email: 'alice_notify@test.notify.spades.invalid',
      username: 'alice_notify',
    })
    bobId = await insertTestPlayer(db, {
      email: 'bob_notify@test.notify.spades.invalid',
      username: 'bob_notify',
    })
    charlieId = await insertTestPlayer(db, {
      email: 'charlie_notify@test.notify.spades.invalid',
      username: 'charlie_notify',
    })
    daveId = await insertTestPlayer(db, {
      email: 'dave_notify@test.notify.spades.invalid',
      username: 'dave_notify',
    })

    aliceHeaders = await authHeaders(redis, { playerId: aliceId, email: 'alice_notify@test.notify.spades.invalid', username: 'alice_notify' })
    bobHeaders = await authHeaders(redis, { playerId: bobId, email: 'bob_notify@test.notify.spades.invalid', username: 'bob_notify' })
    charlieHeaders = await authHeaders(redis, { playerId: charlieId, email: 'charlie_notify@test.notify.spades.invalid', username: 'charlie_notify' })
    daveHeaders = await authHeaders(redis, { playerId: daveId, email: 'dave_notify@test.notify.spades.invalid', username: 'dave_notify' })
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  describe('FRIEND_REQUEST_RECEIVED event via Redis notify channel', () => {
    it('publishes FRIEND_REQUEST_RECEIVED to recipient notify channel when friend request is sent', { timeout: 10000 }, async () => {
      const subscriber = redis.duplicate()
      await subscriber.connect()

      const notifyChannel = `player:${bobId}:notify`
      const received = []

      await subscriber.subscribe(notifyChannel, (message) => {
        received.push(JSON.parse(message))
      })

      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: bobId }),
      })
      assert.equal(res.status, 201)

      await new Promise((resolve) => setTimeout(resolve, 500))

      await subscriber.unsubscribe(notifyChannel)
      await subscriber.quit()

      const friendReqEvent = received.find((e) => e.type === 'FRIEND_REQUEST_RECEIVED')
      assert.ok(friendReqEvent, 'should have received FRIEND_REQUEST_RECEIVED event')
      assert.equal(friendReqEvent.payload.fromPlayerId, aliceId)
      assert.equal(friendReqEvent.payload.fromUsername, 'alice_notify')
    })

    it('does not publish notification to the sender notify channel', { timeout: 10000 }, async () => {
      const subscriber = redis.duplicate()
      await subscriber.connect()

      const senderChannel = `player:${charlieId}:notify`
      const received = []

      await subscriber.subscribe(senderChannel, (message) => {
        received.push(JSON.parse(message))
      })

      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: charlieHeaders,
        body: JSON.stringify({ playerId: daveId }),
      })
      assert.equal(res.status, 201)

      await new Promise((resolve) => setTimeout(resolve, 500))

      await subscriber.unsubscribe(senderChannel)
      await subscriber.quit()

      const friendReqEvent = received.find((e) => e.type === 'FRIEND_REQUEST_RECEIVED')
      assert.equal(friendReqEvent, undefined, 'sender should not receive FRIEND_REQUEST_RECEIVED')
    })

    it('delivers notification to correct recipient channel only', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM friendships WHERE requester_id = $1 OR addressee_id = $1`, [aliceId])

      const subscriber = redis.duplicate()
      await subscriber.connect()

      const daveChannel = `player:${daveId}:notify`
      const aliceChannel = `player:${aliceId}:notify`
      const daveReceived = []
      const aliceReceived = []

      await subscriber.subscribe(daveChannel, (message) => {
        daveReceived.push(JSON.parse(message))
      })
      await subscriber.subscribe(aliceChannel, (message) => {
        aliceReceived.push(JSON.parse(message))
      })

      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: daveId }),
      })
      assert.equal(res.status, 201)

      await new Promise((resolve) => setTimeout(resolve, 500))

      await subscriber.unsubscribe(daveChannel)
      await subscriber.unsubscribe(aliceChannel)
      await subscriber.quit()

      const daveEvent = daveReceived.find((e) => e.type === 'FRIEND_REQUEST_RECEIVED')
      assert.ok(daveEvent, 'dave should receive the notification')
      assert.equal(daveEvent.payload.fromPlayerId, aliceId)

      const aliceEvent = aliceReceived.find((e) => e.type === 'FRIEND_REQUEST_RECEIVED')
      assert.equal(aliceEvent, undefined, 'alice (sender) should not receive the notification')
    })
  })

  describe('Blocked player friend request is silently dropped', () => {
    it('does not publish notification when blocked player sends friend request', { timeout: 10000 }, async () => {
      await fetch(`${server.baseUrl}/api/players/${charlieId}/block`, {
        method: 'POST',
        headers: bobHeaders,
      })

      const subscriber = redis.duplicate()
      await subscriber.connect()

      const notifyChannel = `player:${bobId}:notify`
      const received = []

      await subscriber.subscribe(notifyChannel, (message) => {
        received.push(JSON.parse(message))
      })

      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: charlieHeaders,
        body: JSON.stringify({ playerId: bobId }),
      })
      assert.equal(res.status, 403)

      await new Promise((resolve) => setTimeout(resolve, 500))

      await subscriber.unsubscribe(notifyChannel)
      await subscriber.quit()

      const friendReqEvent = received.find((e) => e.type === 'FRIEND_REQUEST_RECEIVED')
      assert.equal(friendReqEvent, undefined, 'blocked player request should not produce notification')
    })

    it('returns 403 without leaking block status details', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: charlieHeaders,
        body: JSON.stringify({ playerId: bobId }),
      })
      assert.equal(res.status, 403)
      const body = await res.json()
      assert.ok(body.error, 'should have an error message')
      assert.ok(!body.error.toLowerCase().includes('block'), 'error should not reveal block status')
    })
  })

  describe('Accepting friend request via notification', () => {
    it('accepting friend request from notification updates friends list', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM friendships WHERE
        (requester_id = $1 AND addressee_id = $2) OR
        (requester_id = $2 AND addressee_id = $1)`, [bobId, aliceId])

      const reqRes = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: bobHeaders,
        body: JSON.stringify({ playerId: aliceId }),
      })
      assert.equal(reqRes.status, 201)

      const acceptRes = await fetch(`${server.baseUrl}/api/friends/accept`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: bobId }),
      })
      assert.equal(acceptRes.status, 200)
      const acceptBody = await acceptRes.json()
      assert.ok(acceptBody.message)

      const friendsRes = await fetch(`${server.baseUrl}/api/friends`, {
        headers: aliceHeaders,
      })
      assert.equal(friendsRes.status, 200)
      const friendsBody = await friendsRes.json()
      const bob = friendsBody.friends.find((f) => f.playerId === bobId)
      assert.ok(bob, 'bob should appear in alice friends list after accept')
    })

    it('accepting triggers FRIEND_REQUEST_ACCEPTED notification to original requester', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM friendships WHERE
        (requester_id = $1 AND addressee_id = $2) OR
        (requester_id = $2 AND addressee_id = $1)`, [daveId, charlieId])
      await db.query(`DELETE FROM player_blocks WHERE
        (blocker_id = $1 AND blocked_id = $2) OR
        (blocker_id = $2 AND blocked_id = $1)`, [daveId, charlieId])

      const reqRes = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: daveHeaders,
        body: JSON.stringify({ playerId: charlieId }),
      })
      assert.equal(reqRes.status, 201)

      const subscriber = redis.duplicate()
      await subscriber.connect()

      const daveNotifyChannel = `player:${daveId}:notify`
      const received = []

      await subscriber.subscribe(daveNotifyChannel, (message) => {
        received.push(JSON.parse(message))
      })

      const acceptRes = await fetch(`${server.baseUrl}/api/friends/accept`, {
        method: 'POST',
        headers: charlieHeaders,
        body: JSON.stringify({ playerId: daveId }),
      })
      assert.equal(acceptRes.status, 200)

      await new Promise((resolve) => setTimeout(resolve, 500))

      await subscriber.unsubscribe(daveNotifyChannel)
      await subscriber.quit()

      const acceptedEvent = received.find((e) => e.type === 'FRIEND_REQUEST_ACCEPTED')
      assert.ok(acceptedEvent, 'requester should receive FRIEND_REQUEST_ACCEPTED event')
      assert.equal(acceptedEvent.payload.fromPlayerId, charlieId)
      assert.equal(acceptedEvent.payload.fromUsername, 'charlie_notify')
    })
  })

  describe('Notification payload structure', () => {
    it('FRIEND_REQUEST_RECEIVED payload contains required fields', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM friendships WHERE
        (requester_id = $1 AND addressee_id = $2) OR
        (requester_id = $2 AND addressee_id = $1)`, [aliceId, charlieId])
      await db.query(`DELETE FROM player_blocks WHERE
        (blocker_id = $1 AND blocked_id = $2) OR
        (blocker_id = $2 AND blocked_id = $1)`, [aliceId, charlieId])

      const subscriber = redis.duplicate()
      await subscriber.connect()

      const notifyChannel = `player:${charlieId}:notify`
      const received = []

      await subscriber.subscribe(notifyChannel, (message) => {
        received.push(JSON.parse(message))
      })

      await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: charlieId }),
      })

      await new Promise((resolve) => setTimeout(resolve, 500))

      await subscriber.unsubscribe(notifyChannel)
      await subscriber.quit()

      const event = received.find((e) => e.type === 'FRIEND_REQUEST_RECEIVED')
      assert.ok(event, 'should receive event')
      assert.equal(event.type, 'FRIEND_REQUEST_RECEIVED')
      assert.ok(event.payload, 'event should have payload')
      assert.equal(event.payload.fromPlayerId, aliceId)
      assert.ok(event.payload.fromUsername, 'payload should include sender username')
      assert.equal(typeof event.payload.fromUsername, 'string')
    })
  })

  describe('Duplicate and edge cases', () => {
    it('duplicate friend request does not produce a second notification', { timeout: 10000 }, async () => {
      const subscriber = redis.duplicate()
      await subscriber.connect()

      const notifyChannel = `player:${charlieId}:notify`
      const received = []

      await subscriber.subscribe(notifyChannel, (message) => {
        received.push(JSON.parse(message))
      })

      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: charlieId }),
      })
      assert.equal(res.status, 409, 'duplicate request should return 409')

      await new Promise((resolve) => setTimeout(resolve, 500))

      await subscriber.unsubscribe(notifyChannel)
      await subscriber.quit()

      const events = received.filter((e) => e.type === 'FRIEND_REQUEST_RECEIVED')
      assert.equal(events.length, 0, 'no notification on duplicate request')
    })

    it('friend request to non-existent player does not crash notification system', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: '00000000-0000-4000-8000-000000000000' }),
      })
      assert.equal(res.status, 404)
    })

    it('self friend request does not produce notification', { timeout: 10000 }, async () => {
      const subscriber = redis.duplicate()
      await subscriber.connect()

      const notifyChannel = `player:${aliceId}:notify`
      const received = []

      await subscriber.subscribe(notifyChannel, (message) => {
        received.push(JSON.parse(message))
      })

      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ playerId: aliceId }),
      })
      assert.equal(res.status, 400)

      await new Promise((resolve) => setTimeout(resolve, 500))

      await subscriber.unsubscribe(notifyChannel)
      await subscriber.quit()

      const events = received.filter((e) => e.type === 'FRIEND_REQUEST_RECEIVED')
      assert.equal(events.length, 0, 'no notification on self-request')
    })
  })

  describe('Unauthenticated requests', () => {
    it('returns 401 for friend request without auth', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: bobId }),
      })
      assert.equal(res.status, 401)
    })

    it('returns 401 for accept without auth', { timeout: 10000 }, async () => {
      const res = await fetch(`${server.baseUrl}/api/friends/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: aliceId }),
      })
      assert.equal(res.status, 401)
    })
  })
})
