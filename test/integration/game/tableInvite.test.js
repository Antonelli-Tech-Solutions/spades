/**
 * Integration tests for POST /api/tables/:tableId/invite (Issue #678).
 *
 * Covers: host sends in-app invite to a target player, target receives the
 * INVITE_RECEIVED WebSocket event via their Redis notify channel, 403 for
 * non-host callers, 404 for unknown target, 409 for duplicate active invites,
 * re-invite after expiry, and that an invited player can sit at an
 * invite-only table.
 *
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@tinvite.spades.invalid'`)
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

async function createInviteOnlyTable(baseUrl, sessionId, playerId, name = null) {
  const res = await fetch(`${baseUrl}/api/tables`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({ visibility: 'private', name }),
  })
  return { status: res.status, body: await res.json() }
}

async function createPublicTable(baseUrl, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({}),
  })
  return { status: res.status, body: await res.json() }
}

async function sendInvite(baseUrl, tableId, targetPlayerId, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
      'x-table-id': tableId,
    },
    body: JSON.stringify({ playerId: targetPlayerId }),
  })
  return { status: res.status, body: await res.json() }
}

async function sitAtTable(baseUrl, tableId, seat, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/sit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({ seat }),
  })
  return { status: res.status, body: await res.json() }
}

async function collectNotifications(redis, channel, runFn, { waitMs = 500 } = {}) {
  const subscriber = redis.duplicate()
  await subscriber.connect()
  const received = []
  await subscriber.subscribe(channel, (message) => {
    try {
      received.push(JSON.parse(message))
    } catch {
      // ignore
    }
  })
  try {
    const result = await runFn()
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    return { received, result }
  } finally {
    try {
      await subscriber.unsubscribe(channel)
    } catch {}
    await subscriber.quit()
  }
}

describe('POST /api/tables/:tableId/invite', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)

    const specs = [
      { email: 'host@tinvite.spades.invalid', username: 'inv_host', password: 'password123' },
      { email: 'target@tinvite.spades.invalid', username: 'inv_target', password: 'password123' },
      { email: 'other@tinvite.spades.invalid', username: 'inv_other', password: 'password123' },
      { email: 'guest@tinvite.spades.invalid', username: 'inv_guest', password: 'password123' },
    ]
    for (const spec of specs) {
      await insertVerifiedPlayer(db, spec)
    }
    server = await startTestServer(redis)
    for (const spec of specs) {
      const session = await loginPlayer(server.baseUrl, spec.email, spec.password)
      players.push({ ...session, username: spec.username })
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('host sends invite → target receives INVITE_RECEIVED WS event with full payload', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[1]

    const { body: createBody } = await createInviteOnlyTable(
      server.baseUrl,
      host.sessionId,
      host.playerId,
      'Invite Table',
    )
    const tableId = createBody.tableId

    const channel = `player:${target.playerId}:notify`
    const { received, result } = await collectNotifications(redis, channel, () =>
      sendInvite(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId),
    )

    assert.equal(result.status, 200, `Expected 200 but got ${result.status}: ${JSON.stringify(result.body)}`)
    assert.ok(result.body.token, 'response should include a token')
    assert.ok(result.body.expiresAt, 'response should include expiresAt')

    const event = received.find((e) => e.type === 'INVITE_RECEIVED')
    assert.ok(event, `expected INVITE_RECEIVED event. Received: ${JSON.stringify(received)}`)
    assert.ok(event.payload, 'event should have payload')
    assert.equal(event.payload.tableId, tableId, 'payload tableId should match')
    assert.equal(event.payload.tableName, 'Invite Table', 'payload tableName should match')
    assert.equal(event.payload.token, result.body.token, 'payload token should match response token')
    assert.ok(event.payload.invitedBy, 'payload should include invitedBy')
    assert.equal(event.payload.invitedBy.playerId, host.playerId)
    assert.equal(event.payload.invitedBy.username, 'inv_host')
    assert.ok(event.payload.expiresAt, 'payload should include expiresAt')

    // invite key should exist in Redis with the documented shape
    const inviteKey = `invite:${tableId}:${target.playerId}`
    const raw = await redis.get(inviteKey)
    assert.ok(raw, 'invite:{tableId}:{playerId} key should be set in Redis')
    const stored = JSON.parse(raw)
    assert.equal(stored.tableId, tableId)
    assert.equal(stored.token, result.body.token)
    assert.equal(stored.invitedBy, host.playerId)

    // join token should be stored under joinlink:{token}
    const tokenRaw = await redis.get(`joinlink:${result.body.token}`)
    assert.ok(tokenRaw, 'joinlink:{token} key should be set in Redis for the invite token')
    const tokenData = JSON.parse(tokenRaw)
    assert.equal(tokenData.tableId, tableId)

    // cleanup
    await redis.del(inviteKey)
    await redis.del(`joinlink:${result.body.token}`)
    await redis.del(`invited:${tableId}`)
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('non-host caller receives 403', { timeout: 10000 }, async () => {
    const host = players[0]
    const nonHost = players[2]
    const target = players[1]

    const { body: createBody } = await createInviteOnlyTable(
      server.baseUrl,
      host.sessionId,
      host.playerId,
    )
    const tableId = createBody.tableId

    const { status, body } = await sendInvite(
      server.baseUrl,
      tableId,
      target.playerId,
      nonHost.sessionId,
      nonHost.playerId,
    )

    assert.equal(status, 403, `Expected 403 but got ${status}: ${JSON.stringify(body)}`)
    assert.ok(body.error, 'response should include an error message')

    // no invite key should be created
    const inviteKey = `invite:${tableId}:${target.playerId}`
    const raw = await redis.get(inviteKey)
    assert.equal(raw, null, 'no invite key should be created by a non-host caller')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns 404 when target playerId does not exist', { timeout: 10000 }, async () => {
    const host = players[0]
    const fakePlayerId = '00000000-0000-4000-8000-000000000000'

    const { body: createBody } = await createInviteOnlyTable(
      server.baseUrl,
      host.sessionId,
      host.playerId,
    )
    const tableId = createBody.tableId

    const { status, body } = await sendInvite(
      server.baseUrl,
      tableId,
      fakePlayerId,
      host.sessionId,
      host.playerId,
    )

    assert.equal(status, 404, `Expected 404 but got ${status}: ${JSON.stringify(body)}`)
    assert.ok(body.error, 'response should include an error message')

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns 409 DUPLICATE_INVITE when an active invite already exists for (tableId, playerId)', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[1]

    const { body: createBody } = await createInviteOnlyTable(
      server.baseUrl,
      host.sessionId,
      host.playerId,
    )
    const tableId = createBody.tableId

    const first = await sendInvite(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId)
    assert.equal(first.status, 200, `First invite should succeed, got ${first.status}: ${JSON.stringify(first.body)}`)

    const second = await sendInvite(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId)
    assert.equal(second.status, 409, `Duplicate invite should return 409, got ${second.status}: ${JSON.stringify(second.body)}`)
    const errField = (second.body.error || second.body.code || '').toString().toUpperCase()
    assert.ok(
      errField.includes('DUPLICATE_INVITE') || (second.body.code && second.body.code === 'DUPLICATE_INVITE'),
      `409 body should identify DUPLICATE_INVITE. Got: ${JSON.stringify(second.body)}`,
    )

    // cleanup
    await redis.del(`invite:${tableId}:${target.playerId}`)
    if (first.body?.token) await redis.del(`joinlink:${first.body.token}`)
    await redis.del(`invited:${tableId}`)
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('expired invite (manually deleted key) → subsequent invite succeeds', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[1]

    const { body: createBody } = await createInviteOnlyTable(
      server.baseUrl,
      host.sessionId,
      host.playerId,
    )
    const tableId = createBody.tableId

    const first = await sendInvite(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId)
    assert.equal(first.status, 200, `First invite should succeed, got ${first.status}`)

    // simulate TTL expiry by deleting the invite key
    await redis.del(`invite:${tableId}:${target.playerId}`)

    const second = await sendInvite(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId)
    assert.equal(second.status, 200, `Re-invite after expiry should succeed, got ${second.status}: ${JSON.stringify(second.body)}`)
    assert.ok(second.body.token, 'second invite should issue a new token')
    assert.notEqual(second.body.token, first.body.token, 'second invite should produce a different token')

    // cleanup
    await redis.del(`invite:${tableId}:${target.playerId}`)
    if (first.body?.token) await redis.del(`joinlink:${first.body.token}`)
    if (second.body?.token) await redis.del(`joinlink:${second.body.token}`)
    await redis.del(`invited:${tableId}`)
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('invited player can sit at invite-only table after receiving invite', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[3]

    const { body: createBody } = await createInviteOnlyTable(
      server.baseUrl,
      host.sessionId,
      host.playerId,
    )
    const tableId = createBody.tableId

    // Pre-condition: without an invite, target cannot sit at an invite-only table
    const pre = await sitAtTable(server.baseUrl, tableId, 'east', target.sessionId, target.playerId)
    assert.equal(pre.status, 403, `Pre-invite sit should be forbidden, got ${pre.status}: ${JSON.stringify(pre.body)}`)

    const invite = await sendInvite(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId)
    assert.equal(invite.status, 200, `Invite should succeed, got ${invite.status}: ${JSON.stringify(invite.body)}`)

    const sit = await sitAtTable(server.baseUrl, tableId, 'east', target.sessionId, target.playerId)
    assert.equal(sit.status, 200, `Invited player should be able to sit, got ${sit.status}: ${JSON.stringify(sit.body)}`)

    // cleanup
    await redis.del(`invite:${tableId}:${target.playerId}`)
    if (invite.body?.token) await redis.del(`joinlink:${invite.body.token}`)
    await redis.del(`invited:${tableId}`)
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })

  it('returns 404 when table does not exist', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[1]
    const fakeTableId = '00000000-0000-0000-0000-000000000000'

    const { status, body } = await sendInvite(
      server.baseUrl,
      fakeTableId,
      target.playerId,
      host.sessionId,
      host.playerId,
    )
    assert.equal(status, 404, `Expected 404 but got ${status}: ${JSON.stringify(body)}`)
  })

  it('returns 401 without auth headers', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/tables/some-table/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'some-player' }),
    })
    assert.equal(res.status, 401)
  })

  it('returns 400 when request body is missing playerId', { timeout: 10000 }, async () => {
    const host = players[0]

    const { body: createBody } = await createInviteOnlyTable(
      server.baseUrl,
      host.sessionId,
      host.playerId,
    )
    const tableId = createBody.tableId

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/invite`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
        'x-table-id': tableId,
      },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400, `Expected 400 but got ${res.status}`)

    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
  })
})
