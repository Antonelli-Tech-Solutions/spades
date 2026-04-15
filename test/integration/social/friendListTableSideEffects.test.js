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

const EMAIL_DOMAIN = '@test.flts.spades.invalid'

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
    SELECT id FROM players WHERE email LIKE $1
  ) OR addressee_id IN (
    SELECT id FROM players WHERE email LIKE $1
  )`, [`%${EMAIL_DOMAIN}`])
  await db.query(`DELETE FROM player_blocks WHERE blocker_id IN (
    SELECT id FROM players WHERE email LIKE $1
  ) OR blocked_id IN (
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

async function createTable(baseUrl, headers, opts = {}) {
  const res = await fetch(`${baseUrl}/api/tables`, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts),
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  return body.tableId
}

async function leaveTable(baseUrl, headers, tableId) {
  await fetch(`${baseUrl}/api/tables/${tableId}/leave`, {
    method: 'POST',
    headers,
  })
}

async function subscribeToChannel(redis, channel) {
  const subscriber = redis.duplicate()
  await subscriber.connect()
  const received = []
  await subscriber.subscribe(channel, (message) => {
    received.push(JSON.parse(message))
  })
  return { subscriber, received }
}

async function cleanupSubscriber(subscriber, channel) {
  await subscriber.unsubscribe(channel)
  await subscriber.quit()
}

describe('Friend List Changes — Friends-Only Table Side Effects', { skip }, () => {
  let server, db, redis
  let hostId, friendId, newFriendId, strangerId
  let hostHeaders, friendHeaders, newFriendHeaders, strangerHeaders

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await resetTestSchema(db)
    server = await startTestServer(redis)

    hostId = await insertTestPlayer(db, { email: `host${EMAIL_DOMAIN}`, username: 'flts_host' })
    friendId = await insertTestPlayer(db, { email: `friend${EMAIL_DOMAIN}`, username: 'flts_friend' })
    newFriendId = await insertTestPlayer(db, { email: `newfriend${EMAIL_DOMAIN}`, username: 'flts_newfriend' })
    strangerId = await insertTestPlayer(db, { email: `stranger${EMAIL_DOMAIN}`, username: 'flts_stranger' })

    hostHeaders = await authHeaders(redis, { playerId: hostId, email: `host${EMAIL_DOMAIN}`, username: 'flts_host' })
    friendHeaders = await authHeaders(redis, { playerId: friendId, email: `friend${EMAIL_DOMAIN}`, username: 'flts_friend' })
    newFriendHeaders = await authHeaders(redis, { playerId: newFriendId, email: `newfriend${EMAIL_DOMAIN}`, username: 'flts_newfriend' })
    strangerHeaders = await authHeaders(redis, { playerId: strangerId, email: `stranger${EMAIL_DOMAIN}`, username: 'flts_stranger' })
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  // ── Host removes a friend while Friends-Only table is active ──────────

  describe('Host removes a friend while a Friends-Only table is active', () => {
    it('sends TABLE_REMOVED to the removed friend notify channel', { timeout: 10000 }, async () => {
      await addFriendship(db, hostId, friendId)
      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'friends-only' })

      const notifyChannel = `player:${friendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      const res = await fetch(`${server.baseUrl}/api/friends/${friendId}`, {
        method: 'DELETE',
        headers: hostHeaders,
      })
      assert.equal(res.status, 200)

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableRemovedEvent = received.find((e) => e.type === 'TABLE_REMOVED')
      assert.ok(tableRemovedEvent, 'removed friend should receive TABLE_REMOVED event')
      assert.equal(tableRemovedEvent.payload.tableId, tableId)

      await leaveTable(server.baseUrl, hostHeaders, tableId)
    })

    it('includes the correct tableId in TABLE_REMOVED payload', { timeout: 10000 }, async () => {
      await addFriendship(db, hostId, friendId)
      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'friends-only' })

      const notifyChannel = `player:${friendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      await fetch(`${server.baseUrl}/api/friends/${friendId}`, {
        method: 'DELETE',
        headers: hostHeaders,
      })

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const event = received.find((e) => e.type === 'TABLE_REMOVED')
      assert.ok(event, 'should receive TABLE_REMOVED')
      assert.ok(event.payload, 'event should have a payload')
      assert.equal(event.payload.tableId, tableId, 'payload tableId should match the friends-only table')

      await leaveTable(server.baseUrl, hostHeaders, tableId)
    })

    it('friend removing the host also triggers TABLE_REMOVED to the friend', { timeout: 10000 }, async () => {
      await addFriendship(db, hostId, friendId)
      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'friends-only' })

      const notifyChannel = `player:${friendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      const res = await fetch(`${server.baseUrl}/api/friends/${hostId}`, {
        method: 'DELETE',
        headers: friendHeaders,
      })
      assert.equal(res.status, 200)

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableRemovedEvent = received.find((e) => e.type === 'TABLE_REMOVED')
      assert.ok(tableRemovedEvent, 'friend who initiated removal should receive TABLE_REMOVED for host table')
      assert.equal(tableRemovedEvent.payload.tableId, tableId)

      await leaveTable(server.baseUrl, hostHeaders, tableId)
    })
  })

  // ── Host blocks a friend while Friends-Only table is active ───────────

  describe('Host blocks a friend while a Friends-Only table is active', () => {
    it('sends TABLE_REMOVED to the blocked friend notify channel', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM player_blocks WHERE blocker_id = $1 AND blocked_id = $2`, [hostId, friendId])
      await addFriendship(db, hostId, friendId)
      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'friends-only' })

      const notifyChannel = `player:${friendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      const res = await fetch(`${server.baseUrl}/api/players/${friendId}/block`, {
        method: 'POST',
        headers: hostHeaders,
      })
      assert.equal(res.status, 200)

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableRemovedEvent = received.find((e) => e.type === 'TABLE_REMOVED')
      assert.ok(tableRemovedEvent, 'blocked friend should receive TABLE_REMOVED event')
      assert.equal(tableRemovedEvent.payload.tableId, tableId)

      await leaveTable(server.baseUrl, hostHeaders, tableId)
      await db.query(`DELETE FROM player_blocks WHERE blocker_id = $1 AND blocked_id = $2`, [hostId, friendId])
    })

    it('friend blocking the host triggers TABLE_REMOVED to the blocking friend', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM player_blocks WHERE
        (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [hostId, friendId])
      await addFriendship(db, hostId, friendId)
      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'friends-only' })

      const notifyChannel = `player:${friendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      const res = await fetch(`${server.baseUrl}/api/players/${hostId}/block`, {
        method: 'POST',
        headers: friendHeaders,
      })
      assert.equal(res.status, 200)

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableRemovedEvent = received.find((e) => e.type === 'TABLE_REMOVED')
      assert.ok(tableRemovedEvent, 'blocking friend should receive TABLE_REMOVED for host table they can no longer see')
      assert.equal(tableRemovedEvent.payload.tableId, tableId)

      await leaveTable(server.baseUrl, hostHeaders, tableId)
      await db.query(`DELETE FROM player_blocks WHERE
        (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [hostId, friendId])
    })
  })

  // ── Host accepts a new friend request while Friends-Only table is active ─

  describe('Host accepts a new friend request while a Friends-Only table is active', () => {
    it('sends TABLE_CREATED to the new friend notify channel', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM friendships WHERE
        (requester_id = $1 AND addressee_id = $2) OR
        (requester_id = $2 AND addressee_id = $1)`, [hostId, newFriendId])

      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'friends-only' })

      const reqRes = await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: newFriendHeaders,
        body: JSON.stringify({ playerId: hostId }),
      })
      assert.equal(reqRes.status, 201)

      const notifyChannel = `player:${newFriendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      const acceptRes = await fetch(`${server.baseUrl}/api/friends/accept`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ playerId: newFriendId }),
      })
      assert.equal(acceptRes.status, 200)

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableCreatedEvent = received.find((e) => e.type === 'TABLE_CREATED')
      assert.ok(tableCreatedEvent, 'new friend should receive TABLE_CREATED event')
      assert.equal(tableCreatedEvent.payload.tableId, tableId)

      await leaveTable(server.baseUrl, hostHeaders, tableId)
    })

    it('TABLE_CREATED payload includes table state fields', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM friendships WHERE
        (requester_id = $1 AND addressee_id = $2) OR
        (requester_id = $2 AND addressee_id = $1)`, [hostId, newFriendId])

      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'friends-only' })

      await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: newFriendHeaders,
        body: JSON.stringify({ playerId: hostId }),
      })

      const notifyChannel = `player:${newFriendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      await fetch(`${server.baseUrl}/api/friends/accept`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ playerId: newFriendId }),
      })

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const event = received.find((e) => e.type === 'TABLE_CREATED')
      assert.ok(event, 'should receive TABLE_CREATED')
      assert.equal(event.payload.tableId, tableId)
      assert.equal(event.payload.host, hostId)
      assert.equal(event.payload.visibility, 'friends-only')
      assert.ok(event.payload.seats, 'payload should include seats')

      await leaveTable(server.baseUrl, hostHeaders, tableId)
    })

    it('new friend accepting the host request also triggers TABLE_CREATED', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM friendships WHERE
        (requester_id = $1 AND addressee_id = $2) OR
        (requester_id = $2 AND addressee_id = $1)`, [hostId, newFriendId])

      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'friends-only' })

      await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ playerId: newFriendId }),
      })

      const notifyChannel = `player:${newFriendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      const acceptRes = await fetch(`${server.baseUrl}/api/friends/accept`, {
        method: 'POST',
        headers: newFriendHeaders,
        body: JSON.stringify({ playerId: hostId }),
      })
      assert.equal(acceptRes.status, 200)

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableCreatedEvent = received.find((e) => e.type === 'TABLE_CREATED')
      assert.ok(tableCreatedEvent, 'new friend who accepted should receive TABLE_CREATED for host table')
      assert.equal(tableCreatedEvent.payload.tableId, tableId)

      await leaveTable(server.baseUrl, hostHeaders, tableId)
    })
  })

  // ── Side effects do NOT fire for Public tables ────────────────────────

  describe('No side effects for Public tables', () => {
    it('removing a friend with a public table does not send TABLE_REMOVED', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM player_blocks WHERE
        (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [hostId, friendId])
      await addFriendship(db, hostId, friendId)
      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'public' })

      const notifyChannel = `player:${friendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      await fetch(`${server.baseUrl}/api/friends/${friendId}`, {
        method: 'DELETE',
        headers: hostHeaders,
      })

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableRemovedEvent = received.find((e) => e.type === 'TABLE_REMOVED')
      assert.equal(tableRemovedEvent, undefined, 'should NOT send TABLE_REMOVED for public table')

      await leaveTable(server.baseUrl, hostHeaders, tableId)
    })

    it('accepting a friend request with a public table does not send TABLE_CREATED to notify channel', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM friendships WHERE
        (requester_id = $1 AND addressee_id = $2) OR
        (requester_id = $2 AND addressee_id = $1)`, [hostId, newFriendId])

      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'public' })

      await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: newFriendHeaders,
        body: JSON.stringify({ playerId: hostId }),
      })

      const notifyChannel = `player:${newFriendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      await fetch(`${server.baseUrl}/api/friends/accept`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ playerId: newFriendId }),
      })

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableCreatedEvent = received.find((e) => e.type === 'TABLE_CREATED')
      assert.equal(tableCreatedEvent, undefined, 'should NOT send TABLE_CREATED via notify for public table')

      await leaveTable(server.baseUrl, hostHeaders, tableId)
    })
  })

  // ── Side effects do NOT fire for Private tables ───────────────────────

  describe('No side effects for Private tables', () => {
    it('removing a friend with a private table does not send TABLE_REMOVED', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM player_blocks WHERE
        (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [hostId, friendId])
      await addFriendship(db, hostId, friendId)
      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'private' })

      const notifyChannel = `player:${friendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      await fetch(`${server.baseUrl}/api/friends/${friendId}`, {
        method: 'DELETE',
        headers: hostHeaders,
      })

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableRemovedEvent = received.find((e) => e.type === 'TABLE_REMOVED')
      assert.equal(tableRemovedEvent, undefined, 'should NOT send TABLE_REMOVED for private table')

      await leaveTable(server.baseUrl, hostHeaders, tableId)
    })

    it('accepting a friend request with a private table does not send TABLE_CREATED', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM friendships WHERE
        (requester_id = $1 AND addressee_id = $2) OR
        (requester_id = $2 AND addressee_id = $1)`, [hostId, newFriendId])

      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'private' })

      await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: newFriendHeaders,
        body: JSON.stringify({ playerId: hostId }),
      })

      const notifyChannel = `player:${newFriendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      await fetch(`${server.baseUrl}/api/friends/accept`, {
        method: 'POST',
        headers: hostHeaders,
        body: JSON.stringify({ playerId: newFriendId }),
      })

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableCreatedEvent = received.find((e) => e.type === 'TABLE_CREATED')
      assert.equal(tableCreatedEvent, undefined, 'should NOT send TABLE_CREATED for private table')

      await leaveTable(server.baseUrl, hostHeaders, tableId)
    })

    it('blocking a friend with a private table does not send TABLE_REMOVED', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM player_blocks WHERE
        (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [hostId, friendId])
      await addFriendship(db, hostId, friendId)
      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'private' })

      const notifyChannel = `player:${friendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      await fetch(`${server.baseUrl}/api/players/${friendId}/block`, {
        method: 'POST',
        headers: hostHeaders,
      })

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableRemovedEvent = received.find((e) => e.type === 'TABLE_REMOVED')
      assert.equal(tableRemovedEvent, undefined, 'should NOT send TABLE_REMOVED for private table')

      await leaveTable(server.baseUrl, hostHeaders, tableId)
      await db.query(`DELETE FROM player_blocks WHERE blocker_id = $1 AND blocked_id = $2`, [hostId, friendId])
    })
  })

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('no side effects when host has no active table', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM player_blocks WHERE
        (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [hostId, friendId])
      await addFriendship(db, hostId, friendId)

      const notifyChannel = `player:${friendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      const res = await fetch(`${server.baseUrl}/api/friends/${friendId}`, {
        method: 'DELETE',
        headers: hostHeaders,
      })
      assert.equal(res.status, 200)

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableRemovedEvent = received.find((e) => e.type === 'TABLE_REMOVED')
      assert.equal(tableRemovedEvent, undefined, 'no TABLE_REMOVED when host has no active table')
    })

    it('no TABLE_CREATED when accepting friend request and acceptor has no active table', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM friendships WHERE
        (requester_id = $1 AND addressee_id = $2) OR
        (requester_id = $2 AND addressee_id = $1)`, [strangerId, newFriendId])

      await fetch(`${server.baseUrl}/api/friends/request`, {
        method: 'POST',
        headers: newFriendHeaders,
        body: JSON.stringify({ playerId: strangerId }),
      })

      const notifyChannel = `player:${newFriendId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      await fetch(`${server.baseUrl}/api/friends/accept`, {
        method: 'POST',
        headers: strangerHeaders,
        body: JSON.stringify({ playerId: newFriendId }),
      })

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableCreatedEvent = received.find((e) => e.type === 'TABLE_CREATED')
      assert.equal(tableCreatedEvent, undefined, 'no TABLE_CREATED when acceptor has no active table')
    })

    it('blocking a non-friend with a friends-only table does not send TABLE_REMOVED', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM player_blocks WHERE
        (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [hostId, strangerId])
      await db.query(`DELETE FROM friendships WHERE
        (requester_id = $1 AND addressee_id = $2) OR
        (requester_id = $2 AND addressee_id = $1)`, [hostId, strangerId])

      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'friends-only' })

      const notifyChannel = `player:${strangerId}:notify`
      const { subscriber, received } = await subscribeToChannel(redis, notifyChannel)

      await fetch(`${server.baseUrl}/api/players/${strangerId}/block`, {
        method: 'POST',
        headers: hostHeaders,
      })

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(subscriber, notifyChannel)

      const tableRemovedEvent = received.find((e) => e.type === 'TABLE_REMOVED')
      assert.equal(tableRemovedEvent, undefined, 'stranger should NOT receive TABLE_REMOVED since they were never a friend')

      await leaveTable(server.baseUrl, hostHeaders, tableId)
      await db.query(`DELETE FROM player_blocks WHERE blocker_id = $1 AND blocked_id = $2`, [hostId, strangerId])
    })

    it('TABLE_REMOVED is sent only to the affected friend, not other friends', { timeout: 10000 }, async () => {
      await db.query(`DELETE FROM player_blocks WHERE
        (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [hostId, friendId])
      await db.query(`DELETE FROM friendships WHERE
        (requester_id = $1 AND addressee_id = $2) OR
        (requester_id = $2 AND addressee_id = $1)`, [hostId, strangerId])
      await addFriendship(db, hostId, friendId)
      await addFriendship(db, hostId, strangerId)

      const tableId = await createTable(server.baseUrl, hostHeaders, { visibility: 'friends-only' })

      const friendChannel = `player:${friendId}:notify`
      const strangerChannel = `player:${strangerId}:notify`
      const { subscriber: sub1, received: friendReceived } = await subscribeToChannel(redis, friendChannel)
      const { subscriber: sub2, received: strangerReceived } = await subscribeToChannel(redis, strangerChannel)

      await fetch(`${server.baseUrl}/api/friends/${friendId}`, {
        method: 'DELETE',
        headers: hostHeaders,
      })

      await new Promise((resolve) => setTimeout(resolve, 500))
      await cleanupSubscriber(sub1, friendChannel)
      await cleanupSubscriber(sub2, strangerChannel)

      const friendEvent = friendReceived.find((e) => e.type === 'TABLE_REMOVED')
      assert.ok(friendEvent, 'removed friend should receive TABLE_REMOVED')

      const strangerEvent = strangerReceived.find((e) => e.type === 'TABLE_REMOVED')
      assert.equal(strangerEvent, undefined, 'other friends should NOT receive TABLE_REMOVED')

      await leaveTable(server.baseUrl, hostHeaders, tableId)
    })
  })
})
