/**
 * Integration tests for POST /api/invites/:inviteId/decline (Issue #684).
 *
 * Covers: invitee declines an invite (host receives INVITE_DECLINED on their
 * notify channel; all invite-related Redis keys are cleaned up), 410 Gone
 * for unknown / expired inviteId, 403 when a non-invitee tries to decline,
 * and 401 without auth headers. Also asserts that the invite send response
 * and the INVITE_RECEIVED event now include a stable `inviteId`, and that
 * the invite is stored under `invite:id:{inviteId}` with the same TTL.
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@idecline.spades.invalid'`)
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

async function declineInvite(baseUrl, inviteId, sessionId, playerId) {
  const res = await fetch(`${baseUrl}/api/invites/${inviteId}/decline`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
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

async function cleanupInviteKeys(redis, tableId, targetPlayerId, inviteId, token) {
  await redis.del(`invite:${tableId}:${targetPlayerId}`)
  if (inviteId) await redis.del(`invite:id:${inviteId}`)
  if (token) await redis.del(`joinlink:${token}`)
  await redis.del(`invited:${tableId}`)
  await redis.del(`table:${tableId}`)
  await redis.hDel('lobby:tables', tableId)
}

describe('POST /api/invites/:inviteId/decline', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)

    const specs = [
      { email: 'host@idecline.spades.invalid', username: 'dec_host', password: 'password123' },
      { email: 'target@idecline.spades.invalid', username: 'dec_target', password: 'password123' },
      { email: 'other@idecline.spades.invalid', username: 'dec_other', password: 'password123' },
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

  it('invite send response and INVITE_RECEIVED event include a stable inviteId stored under invite:id:{inviteId}', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[1]

    const { body: createBody } = await createInviteOnlyTable(
      server.baseUrl,
      host.sessionId,
      host.playerId,
      'Decline Table A',
    )
    const tableId = createBody.tableId

    const channel = `player:${target.playerId}:notify`
    const { received, result } = await collectNotifications(redis, channel, () =>
      sendInvite(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId),
    )

    assert.equal(result.status, 200, `Expected 200 but got ${result.status}: ${JSON.stringify(result.body)}`)
    assert.ok(result.body.inviteId, 'response should include inviteId')
    assert.match(
      result.body.inviteId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'inviteId should be a UUID',
    )
    assert.ok(result.body.token, 'response should still include token')

    const event = received.find((e) => e.type === 'INVITE_RECEIVED')
    assert.ok(event, `expected INVITE_RECEIVED event. Received: ${JSON.stringify(received)}`)
    assert.equal(event.payload.inviteId, result.body.inviteId, 'event payload should include matching inviteId')

    // invite stored under invite:id:{inviteId} with TTL
    const idKey = `invite:id:${result.body.inviteId}`
    const raw = await redis.get(idKey)
    assert.ok(raw, 'invite:id:{inviteId} key should be set in Redis')
    const stored = JSON.parse(raw)
    assert.equal(stored.tableId, tableId)
    assert.equal(stored.invitedBy, host.playerId)
    // record must reference the invitee for the decline endpoint to identify the invitee
    const inviteeId = stored.invitedPlayerId || stored.targetPlayerId || stored.invitee || stored.playerId
    assert.equal(inviteeId, target.playerId, 'invite:id record should reference the invited player')
    const ttl = await redis.ttl(idKey)
    assert.ok(ttl > 0 && ttl <= 600, `invite:id:{inviteId} TTL should be ~600s, got ${ttl}`)

    // existing invite:{tableId}:{playerId} key should hold (or reference) the inviteId
    const dupKey = `invite:${tableId}:${target.playerId}`
    const dupRaw = await redis.get(dupKey)
    assert.ok(dupRaw, 'invite:{tableId}:{playerId} duplicate-check key should still be set')
    assert.ok(
      dupRaw.includes(result.body.inviteId),
      `duplicate-check key value should reference the inviteId. Got: ${dupRaw}`,
    )

    await cleanupInviteKeys(redis, tableId, target.playerId, result.body.inviteId, result.body.token)
  })

  it('invitee declines → host receives INVITE_DECLINED on notify channel and invite keys are cleaned up', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[1]

    const { body: createBody } = await createInviteOnlyTable(
      server.baseUrl,
      host.sessionId,
      host.playerId,
      'Decline Table B',
    )
    const tableId = createBody.tableId

    const targetChannel = `player:${target.playerId}:notify`
    const { received: targetReceived, result: invite } = await collectNotifications(redis, targetChannel, () =>
      sendInvite(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId),
    )
    assert.equal(invite.status, 200, `Invite send should succeed, got ${invite.status}: ${JSON.stringify(invite.body)}`)

    const inviteEvent = targetReceived.find((e) => e.type === 'INVITE_RECEIVED')
    assert.ok(inviteEvent, 'invitee should have received INVITE_RECEIVED')
    const inviteId = inviteEvent.payload.inviteId
    assert.ok(inviteId, 'INVITE_RECEIVED payload must include inviteId')
    const token = invite.body.token

    // pre-conditions
    assert.ok(await redis.get(`invite:id:${inviteId}`), 'invite:id key should exist before decline')
    assert.ok(await redis.get(`invite:${tableId}:${target.playerId}`), 'invite key should exist before decline')
    assert.ok(await redis.get(`joinlink:${token}`), 'joinlink key should exist before decline')
    assert.equal(
      await redis.sIsMember(`invited:${tableId}`, target.playerId),
      true,
      'invitee should be in invited set before decline',
    )

    const hostChannel = `player:${host.playerId}:notify`
    const { received: hostReceived, result: declineResult } = await collectNotifications(redis, hostChannel, () =>
      declineInvite(server.baseUrl, inviteId, target.sessionId, target.playerId),
    )

    assert.equal(declineResult.status, 200, `Decline should return 200, got ${declineResult.status}: ${JSON.stringify(declineResult.body)}`)
    assert.equal(declineResult.body.inviteId, inviteId, 'decline response should include the inviteId')

    const declined = hostReceived.find((e) => e.type === 'INVITE_DECLINED')
    assert.ok(declined, `host should receive INVITE_DECLINED. Received: ${JSON.stringify(hostReceived)}`)
    assert.ok(declined.payload, 'INVITE_DECLINED should have a payload')
    assert.equal(declined.payload.inviteId, inviteId)
    assert.equal(declined.payload.tableId, tableId)
    assert.ok(declined.payload.declinedBy, 'payload should include declinedBy')
    assert.equal(declined.payload.declinedBy.playerId, target.playerId)
    assert.equal(declined.payload.declinedBy.username, 'dec_target')

    // post-conditions: every invite-related key is gone
    assert.equal(await redis.get(`invite:id:${inviteId}`), null, 'invite:id key should be deleted after decline')
    assert.equal(
      await redis.get(`invite:${tableId}:${target.playerId}`),
      null,
      'invite:{tableId}:{playerId} key should be deleted after decline',
    )
    assert.equal(await redis.get(`joinlink:${token}`), null, 'joinlink key should be deleted after decline')
    assert.equal(
      await redis.sIsMember(`invited:${tableId}`, target.playerId),
      false,
      'invitee should be removed from invited:{tableId} set after decline',
    )

    await cleanupInviteKeys(redis, tableId, target.playerId, inviteId, token)
  })

  it('returns 410 Gone with INVITE_GONE when inviteId does not exist', { timeout: 10000 }, async () => {
    const target = players[1]
    const fakeInviteId = '00000000-0000-4000-8000-000000000001'

    const { status, body } = await declineInvite(
      server.baseUrl,
      fakeInviteId,
      target.sessionId,
      target.playerId,
    )

    assert.equal(status, 410, `Expected 410 Gone but got ${status}: ${JSON.stringify(body)}`)
    assert.equal(body.code, 'INVITE_GONE', `body should include code: INVITE_GONE. Got: ${JSON.stringify(body)}`)
    assert.ok(body.error, 'body should include an error message')
  })

  it('returns 410 Gone when invite has expired (key manually deleted)', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[1]

    const { body: createBody } = await createInviteOnlyTable(
      server.baseUrl,
      host.sessionId,
      host.playerId,
    )
    const tableId = createBody.tableId

    const channel = `player:${target.playerId}:notify`
    const { received, result: invite } = await collectNotifications(redis, channel, () =>
      sendInvite(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId),
    )
    assert.equal(invite.status, 200)
    const inviteEvent = received.find((e) => e.type === 'INVITE_RECEIVED')
    const inviteId = inviteEvent.payload.inviteId

    // Simulate expiry
    await redis.del(`invite:id:${inviteId}`)

    const { status, body } = await declineInvite(
      server.baseUrl,
      inviteId,
      target.sessionId,
      target.playerId,
    )
    assert.equal(status, 410, `Expected 410 but got ${status}: ${JSON.stringify(body)}`)
    assert.equal(body.code, 'INVITE_GONE')

    await cleanupInviteKeys(redis, tableId, target.playerId, inviteId, invite.body.token)
  })

  it('returns 403 when a player who is not the invitee tries to decline', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[1]
    const other = players[2]

    const { body: createBody } = await createInviteOnlyTable(
      server.baseUrl,
      host.sessionId,
      host.playerId,
    )
    const tableId = createBody.tableId

    const channel = `player:${target.playerId}:notify`
    const { received, result: invite } = await collectNotifications(redis, channel, () =>
      sendInvite(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId),
    )
    assert.equal(invite.status, 200, `Invite should succeed, got ${invite.status}`)
    const inviteEvent = received.find((e) => e.type === 'INVITE_RECEIVED')
    const inviteId = inviteEvent.payload.inviteId

    const { status, body } = await declineInvite(
      server.baseUrl,
      inviteId,
      other.sessionId,
      other.playerId,
    )
    assert.equal(status, 403, `Expected 403 but got ${status}: ${JSON.stringify(body)}`)
    assert.ok(body.error, 'body should include an error message')

    // the invite should still exist
    assert.ok(
      await redis.get(`invite:id:${inviteId}`),
      'invite should not be deleted when a non-invitee tries to decline',
    )
    assert.ok(
      await redis.get(`invite:${tableId}:${target.playerId}`),
      'invite key should still exist after failed decline attempt',
    )
    assert.ok(
      await redis.get(`joinlink:${invite.body.token}`),
      'joinlink should still exist after failed decline attempt',
    )

    await cleanupInviteKeys(redis, tableId, target.playerId, inviteId, invite.body.token)
  })

  it('returns 401 when called without auth headers', { timeout: 10000 }, async () => {
    const fakeInviteId = '00000000-0000-4000-8000-000000000002'
    const res = await fetch(`${server.baseUrl}/api/invites/${fakeInviteId}/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    assert.equal(res.status, 401)
  })

  it('a second decline of the same inviteId returns 410 Gone (already consumed)', { timeout: 10000 }, async () => {
    const host = players[0]
    const target = players[1]

    const { body: createBody } = await createInviteOnlyTable(
      server.baseUrl,
      host.sessionId,
      host.playerId,
    )
    const tableId = createBody.tableId

    const channel = `player:${target.playerId}:notify`
    const { received, result: invite } = await collectNotifications(redis, channel, () =>
      sendInvite(server.baseUrl, tableId, target.playerId, host.sessionId, host.playerId),
    )
    assert.equal(invite.status, 200)
    const inviteEvent = received.find((e) => e.type === 'INVITE_RECEIVED')
    const inviteId = inviteEvent.payload.inviteId

    const first = await declineInvite(server.baseUrl, inviteId, target.sessionId, target.playerId)
    assert.equal(first.status, 200, `First decline should succeed, got ${first.status}: ${JSON.stringify(first.body)}`)

    const second = await declineInvite(server.baseUrl, inviteId, target.sessionId, target.playerId)
    assert.equal(second.status, 410, `Second decline should be 410, got ${second.status}: ${JSON.stringify(second.body)}`)
    assert.equal(second.body.code, 'INVITE_GONE')

    await cleanupInviteKeys(redis, tableId, target.playerId, inviteId, invite.body.token)
  })
})
