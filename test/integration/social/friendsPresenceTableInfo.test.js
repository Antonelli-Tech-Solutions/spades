/**
 * Integration tests for GET /api/friends presence + tableInfo enrichment (issue #665).
 *
 * Acceptance criteria:
 *   - Response shape: each friend has { playerId, username, since, presenceStatus, tableInfo }
 *   - presenceStatus: 'online' | 'in-game' | 'offline' (absent presence key = offline)
 *   - tableInfo:
 *     - in-game at public table  → { tableName: <name> }
 *     - in-game at friends-only, requester IS friend of host → { tableName: <name> }
 *     - in-game at friends-only, requester is NOT friend of host → { tableName: null }
 *     - in-game at private table → { tableName: null }
 *     - not in-game → tableInfo is null (no table to look up)
 *   - Existing `pending` field behavior is unchanged
 */

import { describe, it, before, after, beforeEach } from 'node:test'
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

const EMAIL_DOMAIN = '@test.fpti.spades.invalid'

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

async function clearFriendship(db, a, b) {
  await db.query(
    `DELETE FROM friendships WHERE
      (requester_id = $1 AND addressee_id = $2) OR
      (requester_id = $2 AND addressee_id = $1)`,
    [a, b],
  )
}

async function setPresenceOnline(redis, playerId) {
  await redis.set(
    `presence:${playerId}`,
    JSON.stringify({ status: 'online', tableId: null }),
    { EX: 3600 },
  )
}

async function setPresencePlaying(redis, playerId, tableId) {
  await redis.set(
    `presence:${playerId}`,
    JSON.stringify({ status: 'playing', tableId }),
    { EX: 3600 },
  )
}

async function clearPresence(redis, playerId) {
  await redis.del(`presence:${playerId}`)
}

async function seedTable(redis, { tableId, hostPlayerId, name, visibility }) {
  const table = {
    tableId,
    hostPlayerId,
    name,
    seats: { north: null, east: null, south: null, west: null },
    observers: [],
    status: 'playing',
    gameId: null,
    createdAt: new Date().toISOString(),
    visibility,
    joinPolicy: visibility === 'public' ? 'open' : visibility === 'friends-only' ? 'friends-only' : 'invite-only',
    spectating: true,
  }
  await redis.set(`table:${tableId}`, JSON.stringify(table), { EX: 3600 })
  return table
}

async function clearTable(redis, tableId) {
  await redis.del(`table:${tableId}`)
  await redis.hDel('lobby:tables', tableId)
  await redis.hDel('lobby:all', tableId)
}

function randomId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

describe('GET /api/friends presence + tableInfo enrichment', { skip }, () => {
  let server, db, redis
  let aliceId, bobId, charlieId, dianaId, evanId
  let aliceHeaders

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await resetTestSchema(db)
    server = await startTestServer(redis)

    aliceId = await insertTestPlayer(db, { email: `alice${EMAIL_DOMAIN}`, username: 'fpti_alice' })
    bobId = await insertTestPlayer(db, { email: `bob${EMAIL_DOMAIN}`, username: 'fpti_bob' })
    charlieId = await insertTestPlayer(db, { email: `charlie${EMAIL_DOMAIN}`, username: 'fpti_charlie' })
    dianaId = await insertTestPlayer(db, { email: `diana${EMAIL_DOMAIN}`, username: 'fpti_diana' })
    evanId = await insertTestPlayer(db, { email: `evan${EMAIL_DOMAIN}`, username: 'fpti_evan' })

    aliceHeaders = await authHeaders(redis, {
      playerId: aliceId,
      email: `alice${EMAIL_DOMAIN}`,
      username: 'fpti_alice',
    })

    // Alice is friends with Bob, Charlie, and Diana. Not friends with Evan.
    await addFriendship(db, aliceId, bobId)
    await addFriendship(db, aliceId, charlieId)
    await addFriendship(db, aliceId, dianaId)
  })

  after(async () => {
    // Best-effort cleanup of any lingering presence/table keys for our test players.
    for (const id of [aliceId, bobId, charlieId, dianaId, evanId]) {
      if (id) await redis.del(`presence:${id}`)
    }
    await server.close()
    await closeDb()
    await closeRedis()
  })

  beforeEach(async () => {
    for (const id of [aliceId, bobId, charlieId, dianaId, evanId]) {
      await clearPresence(redis, id)
    }
  })

  it('returns presenceStatus and tableInfo fields for every friend', { timeout: 10000 }, async () => {
    await setPresenceOnline(redis, bobId)

    const res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body.friends))
    for (const f of body.friends) {
      assert.ok('presenceStatus' in f, `friend ${f.username} should have presenceStatus`)
      assert.ok('tableInfo' in f, `friend ${f.username} should have tableInfo`)
      assert.ok(['online', 'in-game', 'offline'].includes(f.presenceStatus),
        `presenceStatus ${f.presenceStatus} must be one of the allowed values`)
    }
  })

  it('returns presenceStatus="online" for a friend with status="online" in Redis', { timeout: 10000 }, async () => {
    await setPresenceOnline(redis, bobId)

    const res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
    const body = await res.json()
    const bob = body.friends.find((f) => f.playerId === bobId)
    assert.ok(bob)
    assert.equal(bob.presenceStatus, 'online')
    assert.equal(bob.tableInfo, null, 'online (not in-game) friend should have tableInfo null')
  })

  it('returns presenceStatus="offline" for a friend with no presence key', { timeout: 10000 }, async () => {
    // Ensure no presence key exists for Charlie
    await clearPresence(redis, charlieId)

    const res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
    const body = await res.json()
    const charlie = body.friends.find((f) => f.playerId === charlieId)
    assert.ok(charlie)
    assert.equal(charlie.presenceStatus, 'offline')
    assert.equal(charlie.tableInfo, null, 'offline friend should have tableInfo null')
  })

  it('returns presenceStatus="in-game" with {tableName} for a friend at a PUBLIC table', { timeout: 10000 }, async () => {
    const tableId = randomId('table-public')
    await seedTable(redis, { tableId, hostPlayerId: bobId, name: 'Public Table 1', visibility: 'public' })
    await setPresencePlaying(redis, bobId, tableId)

    try {
      const res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
      const body = await res.json()
      const bob = body.friends.find((f) => f.playerId === bobId)
      assert.ok(bob)
      assert.equal(bob.presenceStatus, 'in-game')
      assert.ok(bob.tableInfo, 'tableInfo should be present for in-game friend')
      assert.equal(bob.tableInfo.tableName, 'Public Table 1')
    } finally {
      await clearTable(redis, tableId)
    }
  })

  it('returns presenceStatus="in-game" with {tableName: null} for a friend at a PRIVATE table', { timeout: 10000 }, async () => {
    const tableId = randomId('table-private')
    await seedTable(redis, { tableId, hostPlayerId: bobId, name: 'Private Table 1', visibility: 'private' })
    await setPresencePlaying(redis, bobId, tableId)

    try {
      const res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
      const body = await res.json()
      const bob = body.friends.find((f) => f.playerId === bobId)
      assert.ok(bob)
      assert.equal(bob.presenceStatus, 'in-game')
      assert.ok(bob.tableInfo, 'tableInfo should still be present (null name, not null object)')
      assert.equal(bob.tableInfo.tableName, null)
    } finally {
      await clearTable(redis, tableId)
    }
  })

  it('returns {tableName} for a FRIENDS-ONLY table when requester IS friend of host', { timeout: 10000 }, async () => {
    // Bob is Alice's friend and hosts a friends-only table → Alice is friend of host.
    const tableId = randomId('table-fo-friend')
    await seedTable(redis, { tableId, hostPlayerId: bobId, name: 'Bob Friends Table', visibility: 'friends-only' })
    await setPresencePlaying(redis, bobId, tableId)

    try {
      const res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
      const body = await res.json()
      const bob = body.friends.find((f) => f.playerId === bobId)
      assert.ok(bob)
      assert.equal(bob.presenceStatus, 'in-game')
      assert.ok(bob.tableInfo)
      assert.equal(bob.tableInfo.tableName, 'Bob Friends Table')
    } finally {
      await clearTable(redis, tableId)
    }
  })

  it('returns {tableName: null} for a FRIENDS-ONLY table when requester is NOT friend of host', { timeout: 10000 }, async () => {
    // Bob (Alice's friend) is seated at a friends-only table hosted by Evan (NOT Alice's friend).
    const tableId = randomId('table-fo-stranger')
    await seedTable(redis, { tableId, hostPlayerId: evanId, name: 'Evan Secret Table', visibility: 'friends-only' })
    await setPresencePlaying(redis, bobId, tableId)

    // Sanity: Alice must not be friends with Evan for this test to be meaningful.
    await clearFriendship(db, aliceId, evanId)

    try {
      const res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
      const body = await res.json()
      const bob = body.friends.find((f) => f.playerId === bobId)
      assert.ok(bob)
      assert.equal(bob.presenceStatus, 'in-game')
      assert.ok(bob.tableInfo, 'tableInfo object should exist even when name is hidden')
      assert.equal(bob.tableInfo.tableName, null, 'table name must NOT leak to non-friend of host')
    } finally {
      await clearTable(redis, tableId)
    }
  })

  it('returns {tableName} for a FRIENDS-ONLY table hosted by a third party who IS a friend of requester', { timeout: 10000 }, async () => {
    // Bob is Alice's friend, playing at Diana's friends-only table. Diana is also Alice's friend.
    const tableId = randomId('table-fo-thirdparty')
    await seedTable(redis, { tableId, hostPlayerId: dianaId, name: 'Diana Table', visibility: 'friends-only' })
    await setPresencePlaying(redis, bobId, tableId)

    try {
      const res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
      const body = await res.json()
      const bob = body.friends.find((f) => f.playerId === bobId)
      assert.ok(bob)
      assert.equal(bob.presenceStatus, 'in-game')
      assert.ok(bob.tableInfo)
      assert.equal(bob.tableInfo.tableName, 'Diana Table',
        'host (Diana) is a friend of the requester (Alice), so name should be disclosed')
    } finally {
      await clearTable(redis, tableId)
    }
  })

  it('returns presenceStatus="in-game" with tableInfo null if the referenced table is missing from Redis', { timeout: 10000 }, async () => {
    // Dangling presence: player claims to be at a table, but the table key is gone (expired/cleaned up).
    const tableId = randomId('table-missing')
    await clearTable(redis, tableId) // make absolutely sure it's gone
    await setPresencePlaying(redis, bobId, tableId)

    const res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
    const body = await res.json()
    const bob = body.friends.find((f) => f.playerId === bobId)
    assert.ok(bob)
    assert.equal(bob.presenceStatus, 'in-game')
    // Acceptable: tableInfo is either null or { tableName: null } — both convey "no visible table name".
    if (bob.tableInfo !== null) {
      assert.equal(bob.tableInfo.tableName, null, 'missing table must not leak a name')
    }
  })

  it('mixes presence states across multiple friends in a single response', { timeout: 10000 }, async () => {
    const publicTableId = randomId('table-mix-public')
    await seedTable(redis, { tableId: publicTableId, hostPlayerId: bobId, name: 'Mixed Public', visibility: 'public' })
    await setPresencePlaying(redis, bobId, publicTableId)
    await setPresenceOnline(redis, dianaId)
    await clearPresence(redis, charlieId) // offline

    try {
      const res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
      const body = await res.json()
      const bob = body.friends.find((f) => f.playerId === bobId)
      const charlie = body.friends.find((f) => f.playerId === charlieId)
      const diana = body.friends.find((f) => f.playerId === dianaId)

      assert.equal(bob.presenceStatus, 'in-game')
      assert.equal(bob.tableInfo.tableName, 'Mixed Public')

      assert.equal(charlie.presenceStatus, 'offline')
      assert.equal(charlie.tableInfo, null)

      assert.equal(diana.presenceStatus, 'online')
      assert.equal(diana.tableInfo, null)
    } finally {
      await clearTable(redis, publicTableId)
    }
  })

  it('does not change existing `pending` field behavior', { timeout: 10000 }, async () => {
    // Have Evan send Alice a pending friend request.
    await clearFriendship(db, aliceId, evanId)
    const reqRes = await fetch(`${server.baseUrl}/api/friends/request`, {
      method: 'POST',
      headers: await authHeaders(redis, { playerId: evanId, email: `evan${EMAIL_DOMAIN}`, username: 'fpti_evan' }),
      body: JSON.stringify({ playerId: aliceId }),
    })
    assert.equal(reqRes.status, 201)

    try {
      const res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
      const body = await res.json()
      assert.ok(Array.isArray(body.pending), 'pending should still be an array')
      const evanPending = body.pending.find((p) => p.playerId === evanId)
      assert.ok(evanPending, 'pending request from Evan should be present')
      assert.equal(evanPending.username, 'fpti_evan')
      // Pending entries should NOT be enriched with presence/table info (unchanged behavior).
      assert.equal(evanPending.presenceStatus, undefined, 'pending entries should not carry presenceStatus')
      assert.equal(evanPending.tableInfo, undefined, 'pending entries should not carry tableInfo')
    } finally {
      await clearFriendship(db, aliceId, evanId)
    }
  })

  it('preserves existing friend fields (playerId, username, since)', { timeout: 10000 }, async () => {
    await setPresenceOnline(redis, bobId)

    const res = await fetch(`${server.baseUrl}/api/friends`, { headers: aliceHeaders })
    const body = await res.json()
    const bob = body.friends.find((f) => f.playerId === bobId)
    assert.ok(bob)
    assert.equal(bob.username, 'fpti_bob')
    assert.ok(bob.since, 'since field should still be set')
  })
})
