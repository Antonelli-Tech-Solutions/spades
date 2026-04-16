/**
 * Integration tests: Redis presence state machine (issue #664).
 *
 * Every player has a `presence:{playerId}` key tracking their current status.
 * Verifies status transitions through the connection lifecycle:
 *
 *   WS connect       → { status: 'online',  tableId: null }
 *   sitAtTable()     → { status: 'playing', tableId }
 *   leaveTable()     → { status: 'online',  tableId: null }
 *   WS disconnect    → removed from Redis (or { status: 'offline' })
 *
 * Also verifies a TTL is applied as a safety net against stale keys.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import WebSocket from 'ws'
import { createWsServer } from '../../server/ws/index.js'
import { getRedis, closeRedis } from '../../server/redis.js'
import { createTable, sitAtTable, leaveTable, standFromSeat } from '../../server/lobby/table.js'
import { handler } from '../../server/server.js'
import { createSession } from '../../server/auth/session.js'

const skip = !process.env.REDIS_URL ? 'REDIS_URL must be set' : false

// ── Helpers ───────────────────────────────────────────────────────────────────

function wsConnect(server, headers = {}, wsOpts = {}) {
  const { port } = server.address()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers, ...wsOpts })
    ws.once('open', () => {
      // Allow the server's async connection handler (presence write, notify subscribe)
      // to complete before the test reads Redis.
      setTimeout(() => resolve(ws), 150)
    })
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }))
    })
  })
}

function waitClose(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve()
    ws.once('close', () => resolve())
  })
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function readPresence(redis, playerId) {
  const raw = await redis.get(`presence:${playerId}`)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Presence state machine', { skip }, () => {
  let httpServer, wss, redis

  before(async () => {
    redis = await getRedis()
    httpServer = http.createServer()
    wss = createWsServer(httpServer, {
      redis,
      pingIntervalMs: 30_000,
      pongTimeoutMs: 10_000,
    })
    await wss._subscriberReady
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  })

  after(async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => httpServer.close(resolve))
    await closeRedis()
  })

  // ── WS connect → online ─────────────────────────────────────────────────────

  describe('on WebSocket connect', () => {
    const playerId = 'presence-player-connect'
    const sessionId = 'presence-session-connect'

    beforeEach(async () => {
      await redis.set(`session:${sessionId}`, JSON.stringify({ playerId, username: 'ConnectPlayer' }))
      await redis.del(`presence:${playerId}`)
    })

    afterEach(async () => {
      await redis.del(`session:${sessionId}`)
      await redis.del(`presence:${playerId}`)
    })

    it('sets presence to { status: "online", tableId: null } when a client connects', { timeout: 15000 }, async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': sessionId })

      const presence = await readPresence(redis, playerId)
      assert.ok(presence, 'presence key should be written on connect')
      assert.equal(presence.status, 'online', 'status should be "online" on connect')
      assert.equal(presence.tableId, null, 'tableId should be null when not at a table')

      ws.close()
      await waitClose(ws)
    })

    it('presence key has a positive TTL (safety net against stale keys)', { timeout: 15000 }, async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': sessionId })

      const ttl = await redis.ttl(`presence:${playerId}`)
      // TTL > 0 means a TTL is set (Redis returns -1 if no TTL, -2 if key does not exist).
      assert.ok(ttl > 0, `presence key should have a TTL set, got ${ttl}`)

      ws.close()
      await waitClose(ws)
    })
  })

  // ── sitAtTable → playing ────────────────────────────────────────────────────

  describe('on sitting at a table', () => {
    const playerId = 'presence-player-sit'

    beforeEach(async () => {
      await redis.del(`presence:${playerId}`)
    })

    afterEach(async () => {
      await redis.del(`presence:${playerId}`)
    })

    it('updates presence to { status: "playing", tableId } when the player sits', { timeout: 15000 }, async () => {
      const table = await createTable(redis, { hostPlayerId: playerId })
      try {
        await sitAtTable(redis, table.tableId, playerId, 'north')

        const presence = await readPresence(redis, playerId)
        assert.ok(presence, 'presence key should exist after sitting')
        assert.equal(presence.status, 'playing', 'status should be "playing" after sit')
        assert.equal(presence.tableId, table.tableId, 'tableId should match the table the player sat at')
      } finally {
        await redis.del(`table:${table.tableId}`)
        await redis.hDel('lobby:tables', table.tableId)
        await redis.hDel('lobby:all', table.tableId)
      }
    })

    it('presence key continues to have a TTL after sitting', { timeout: 15000 }, async () => {
      const table = await createTable(redis, { hostPlayerId: playerId })
      try {
        await sitAtTable(redis, table.tableId, playerId, 'south')

        const ttl = await redis.ttl(`presence:${playerId}`)
        assert.ok(ttl > 0, `presence key should have a TTL after sit, got ${ttl}`)
      } finally {
        await redis.del(`table:${table.tableId}`)
        await redis.hDel('lobby:tables', table.tableId)
        await redis.hDel('lobby:all', table.tableId)
      }
    })
  })

  // ── standFromSeat → online ──────────────────────────────────────────────────

  describe('on standing from a seat', () => {
    const playerId = 'presence-player-stand'
    const partnerId = 'presence-player-stand-partner'

    beforeEach(async () => {
      await redis.del(`presence:${playerId}`)
      await redis.del(`presence:${partnerId}`)
    })

    afterEach(async () => {
      await redis.del(`presence:${playerId}`)
      await redis.del(`presence:${partnerId}`)
    })

    it('updates presence back to { status: "online", tableId: null } when the player stands from a seat', { timeout: 15000 }, async () => {
      // Need a second seated human so the player who stands is not the host
      // (host cannot stand if no other human remains seated).
      const table = await createTable(redis, { hostPlayerId: partnerId })
      try {
        await sitAtTable(redis, table.tableId, partnerId, 'north')
        await sitAtTable(redis, table.tableId, playerId, 'south')

        // Sanity: player is currently "playing"
        const before = await readPresence(redis, playerId)
        assert.equal(before.status, 'playing', 'precondition: player should be "playing" after sit')
        assert.equal(before.tableId, table.tableId)

        await standFromSeat(redis, table.tableId, playerId)

        const after = await readPresence(redis, playerId)
        assert.ok(after, 'presence key should still exist after standing (player is still online)')
        assert.equal(after.status, 'online', 'status should be "online" after standing from seat')
        assert.equal(after.tableId, null, 'tableId should be cleared after standing from seat')
      } finally {
        await redis.del(`table:${table.tableId}`)
        await redis.hDel('lobby:tables', table.tableId)
        await redis.hDel('lobby:all', table.tableId)
      }
    })
  })

  // ── leaveTable → online ─────────────────────────────────────────────────────

  describe('on leaving a table', () => {
    const playerId = 'presence-player-leave'
    const partnerId = 'presence-player-leave-partner'

    beforeEach(async () => {
      await redis.del(`presence:${playerId}`)
      await redis.del(`presence:${partnerId}`)
    })

    afterEach(async () => {
      await redis.del(`presence:${playerId}`)
      await redis.del(`presence:${partnerId}`)
    })

    it('updates presence back to { status: "online", tableId: null } when the player leaves', { timeout: 15000 }, async () => {
      // Need a second human so the table isn't terminated when our player leaves.
      const table = await createTable(redis, { hostPlayerId: partnerId })
      try {
        await sitAtTable(redis, table.tableId, partnerId, 'north')
        await sitAtTable(redis, table.tableId, playerId, 'south')

        // Sanity: player is currently "playing"
        const before = await readPresence(redis, playerId)
        assert.equal(before.status, 'playing', 'precondition: player should be "playing" after sit')
        assert.equal(before.tableId, table.tableId)

        await leaveTable(redis, table.tableId, playerId)

        const after = await readPresence(redis, playerId)
        assert.ok(after, 'presence key should still exist after leaving (player is still online)')
        assert.equal(after.status, 'online', 'status should be "online" after leaving the table')
        assert.equal(after.tableId, null, 'tableId should be cleared after leaving')
      } finally {
        await redis.del(`table:${table.tableId}`)
        await redis.del(`game:${table.tableId}`)
        await redis.hDel('lobby:tables', table.tableId)
        await redis.hDel('lobby:all', table.tableId)
      }
    })
  })

  // ── WS disconnect → offline / removed ───────────────────────────────────────

  describe('on WebSocket disconnect', () => {
    const playerId = 'presence-player-dc'
    const sessionId = 'presence-session-dc'

    beforeEach(async () => {
      await redis.set(`session:${sessionId}`, JSON.stringify({ playerId, username: 'DCPlayer' }))
      await redis.del(`presence:${playerId}`)
    })

    afterEach(async () => {
      await redis.del(`session:${sessionId}`)
      await redis.del(`presence:${playerId}`)
    })

    it('removes presence key (or sets status to "offline") after the client disconnects', { timeout: 15000 }, async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': sessionId })

      // Sanity: presence was written on connect
      const connected = await readPresence(redis, playerId)
      assert.ok(connected, 'precondition: presence should exist after connect')
      assert.equal(connected.status, 'online')

      ws.close()
      await waitClose(ws)
      // Give the async close handler time to run
      await delay(150)

      const presence = await readPresence(redis, playerId)
      if (presence === null) {
        // Option A: key deleted — acceptable per spec
        assert.equal(presence, null, 'presence key may be deleted on disconnect')
      } else {
        // Option B: status set to "offline" — also acceptable per spec
        assert.equal(presence.status, 'offline', 'if presence key remains, status must be "offline"')
      }
    })

    it('does not leave stale "online" presence after disconnect', { timeout: 15000 }, async () => {
      const ws = await wsConnect(httpServer, { 'x-session-id': sessionId })
      ws.close()
      await waitClose(ws)
      await delay(150)

      const presence = await readPresence(redis, playerId)
      if (presence !== null) {
        assert.notEqual(presence.status, 'online', 'stale "online" presence must not remain after disconnect')
        assert.notEqual(presence.status, 'playing', 'stale "playing" presence must not remain after disconnect')
      }
    })
  })

  // ── Reconnect while seated must not clobber 'playing' ───────────────────────

  describe('WS connect reconciles with seat state', () => {
    const playerId = 'presence-player-reconnect'
    const sessionId = 'presence-session-reconnect'
    const partnerId = 'presence-player-reconnect-partner'

    beforeEach(async () => {
      await redis.set(`session:${sessionId}`, JSON.stringify({ playerId, username: 'ReconnectPlayer' }))
      await redis.del(`presence:${playerId}`)
      await redis.del(`presence:${partnerId}`)
    })

    afterEach(async () => {
      await redis.del(`session:${sessionId}`)
      await redis.del(`presence:${playerId}`)
      await redis.del(`presence:${partnerId}`)
    })

    it('reconnect while seated restores presence to "playing" (does not overwrite with "online")', { timeout: 15000 }, async () => {
      const table = await createTable(redis, { hostPlayerId: partnerId })
      try {
        await sitAtTable(redis, table.tableId, partnerId, 'north')

        // First connection + sit — presence is 'playing'
        const ws1 = await wsConnect(httpServer, { 'x-session-id': sessionId })
        await sitAtTable(redis, table.tableId, playerId, 'south')

        const duringPlay = await readPresence(redis, playerId)
        assert.equal(duringPlay.status, 'playing', 'precondition: seated player is "playing"')
        assert.equal(duringPlay.tableId, table.tableId)

        // Disconnect — clearPresence removes the key
        ws1.close()
        await waitClose(ws1)
        await delay(200)

        // Reconnect — must recognise the player is still seated and restore 'playing'
        const ws2 = await wsConnect(httpServer, { 'x-session-id': sessionId })
        const reconnected = await readPresence(redis, playerId)
        assert.ok(reconnected, 'presence should exist after reconnect')
        assert.equal(reconnected.status, 'playing', 'reconnect while seated must restore "playing"')
        assert.equal(reconnected.tableId, table.tableId, 'reconnect must carry the same tableId')

        ws2.close()
        await waitClose(ws2)
      } finally {
        await redis.del(`table:${table.tableId}`)
        await redis.del(`game:${table.tableId}`)
        await redis.hDel('lobby:tables', table.tableId)
        await redis.hDel('lobby:all', table.tableId)
      }
    })

    it('opening a second WS connection while seated does not overwrite "playing"', { timeout: 15000 }, async () => {
      const table = await createTable(redis, { hostPlayerId: partnerId })
      try {
        await sitAtTable(redis, table.tableId, partnerId, 'north')

        const wsA = await wsConnect(httpServer, { 'x-session-id': sessionId })
        await sitAtTable(redis, table.tableId, playerId, 'south')

        const before = await readPresence(redis, playerId)
        assert.equal(before.status, 'playing', 'precondition: "playing" before second tab opens')

        // Second tab — connect handler must not blow away the 'playing' state
        const wsB = await wsConnect(httpServer, { 'x-session-id': sessionId })
        const after = await readPresence(redis, playerId)
        assert.equal(after.status, 'playing', 'multi-tab connect must not overwrite "playing" with "online"')
        assert.equal(after.tableId, table.tableId, 'tableId must not be cleared on multi-tab connect')

        wsA.close()
        await waitClose(wsA)
        wsB.close()
        await waitClose(wsB)
      } finally {
        await redis.del(`table:${table.tableId}`)
        await redis.del(`game:${table.tableId}`)
        await redis.hDel('lobby:tables', table.tableId)
        await redis.hDel('lobby:all', table.tableId)
      }
    })
  })

  // ── Host terminate clears presence for all seated humans ───────────────────

  describe('on host terminating the table', () => {
    const hostId = 'presence-player-term-host'
    const partnerId = 'presence-player-term-partner'
    const hostSessionId = 'presence-session-term-host'

    let apiServer, apiBaseUrl

    before(async () => {
      const app = express()
      app.use(express.json())
      handler(app, { redis })
      await new Promise((resolve) => {
        apiServer = app.listen(0, '127.0.0.1', resolve)
      })
      const { port } = apiServer.address()
      apiBaseUrl = `http://127.0.0.1:${port}`
    })

    after(async () => {
      await new Promise((resolve) => apiServer.close(resolve))
    })

    beforeEach(async () => {
      await redis.del(`presence:${hostId}`)
      await redis.del(`presence:${partnerId}`)
      await redis.del(`session:${hostSessionId}`)
    })

    afterEach(async () => {
      await redis.del(`presence:${hostId}`)
      await redis.del(`presence:${partnerId}`)
      await redis.del(`session:${hostSessionId}`)
    })

    it('clears presence back to { status: "online", tableId: null } for every seated human when host terminates', { timeout: 15000 }, async () => {
      const table = await createTable(redis, { hostPlayerId: hostId })
      try {
        await sitAtTable(redis, table.tableId, hostId, 'north')
        await sitAtTable(redis, table.tableId, partnerId, 'south')

        // Sanity: both players are "playing"
        const hostBefore = JSON.parse(await redis.get(`presence:${hostId}`))
        const partnerBefore = JSON.parse(await redis.get(`presence:${partnerId}`))
        assert.equal(hostBefore.status, 'playing')
        assert.equal(hostBefore.tableId, table.tableId)
        assert.equal(partnerBefore.status, 'playing')
        assert.equal(partnerBefore.tableId, table.tableId)

        // Install a known session id for the host so we can authenticate the request.
        await redis.set(
          `session:${hostSessionId}`,
          JSON.stringify({ playerId: hostId, email: 'host@term.spades.invalid', username: 'HostPlayer' }),
        )

        const res = await fetch(`${apiBaseUrl}/api/tables/${table.tableId}/terminate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-session-id': hostSessionId,
            'x-player-id': hostId,
          },
        })
        assert.equal(res.status, 200, 'terminate request should succeed')

        const hostAfter = await readPresence(redis, hostId)
        const partnerAfter = await readPresence(redis, partnerId)
        assert.ok(hostAfter, 'host presence key should still exist (host is still online)')
        assert.equal(hostAfter.status, 'online', 'host status should be "online" after terminate')
        assert.equal(hostAfter.tableId, null, 'host tableId should be cleared after terminate')
        assert.ok(partnerAfter, 'partner presence key should still exist (partner is still online)')
        assert.equal(partnerAfter.status, 'online', 'partner status should be "online" after terminate')
        assert.equal(partnerAfter.tableId, null, 'partner tableId should be cleared after terminate')
      } finally {
        await redis.del(`table:${table.tableId}`)
        await redis.del(`game:${table.tableId}`)
        await redis.hDel('lobby:tables', table.tableId)
        await redis.hDel('lobby:all', table.tableId)
      }
    })
  })

  // ── Full lifecycle: connect → sit → leave → disconnect ──────────────────────

  describe('full lifecycle transitions', () => {
    const playerId = 'presence-player-full'
    const sessionId = 'presence-session-full'
    const partnerId = 'presence-player-full-partner'

    beforeEach(async () => {
      await redis.set(`session:${sessionId}`, JSON.stringify({ playerId, username: 'FullPlayer' }))
      await redis.del(`presence:${playerId}`)
      await redis.del(`presence:${partnerId}`)
    })

    afterEach(async () => {
      await redis.del(`session:${sessionId}`)
      await redis.del(`presence:${playerId}`)
      await redis.del(`presence:${partnerId}`)
    })

    it('walks the full state machine: connect → online, sit → playing, leave → online, disconnect → removed/offline', { timeout: 15000 }, async () => {
      // 1. Connect → online
      const ws = await wsConnect(httpServer, { 'x-session-id': sessionId })
      const onConnect = await readPresence(redis, playerId)
      assert.equal(onConnect.status, 'online', 'connect → status "online"')
      assert.equal(onConnect.tableId, null, 'connect → tableId null')

      // Create a table with another host so our player can sit and later leave
      // without terminating the table (which would require no human players).
      const table = await createTable(redis, { hostPlayerId: partnerId })
      await sitAtTable(redis, table.tableId, partnerId, 'north')

      try {
        // 2. Sit → playing
        await sitAtTable(redis, table.tableId, playerId, 'south')
        const onSit = await readPresence(redis, playerId)
        assert.equal(onSit.status, 'playing', 'sit → status "playing"')
        assert.equal(onSit.tableId, table.tableId, 'sit → tableId matches')

        // 3. Leave → online
        await leaveTable(redis, table.tableId, playerId)
        const onLeave = await readPresence(redis, playerId)
        assert.equal(onLeave.status, 'online', 'leave → status "online"')
        assert.equal(onLeave.tableId, null, 'leave → tableId null')

        // 4. Disconnect → removed or offline
        ws.close()
        await waitClose(ws)
        await delay(150)
        const onDisconnect = await readPresence(redis, playerId)
        if (onDisconnect !== null) {
          assert.equal(onDisconnect.status, 'offline', 'disconnect → key removed or status "offline"')
        }
      } finally {
        await redis.del(`table:${table.tableId}`)
        await redis.del(`game:${table.tableId}`)
        await redis.hDel('lobby:tables', table.tableId)
        await redis.hDel('lobby:all', table.tableId)
      }
    })
  })
})
