/**
 * Integration tests: SEAT_TAKEN and SEAT_VACATED events are broadcast to the
 * table room channel when a player joins or leaves a waiting table.
 *
 * Verifies that players already seated at a waiting table receive real-time
 * seat-change events so the "Waiting for players..." screen stays in sync
 * without requiring a manual refresh.
 *
 * Issue #257 — the server was only emitting TABLE_UPDATED to the lobby
 * channel, never to the table room channel. Players on the waiting screen
 * are connected to the table room (not the lobby), so they never saw updates.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import WebSocket from 'ws'
import { handler } from '../../server/server.js'
import { createWsServer } from '../../server/ws/index.js'
import { getRedis, closeRedis } from '../../server/redis.js'

const skip = !process.env.REDIS_URL ? 'REDIS_URL must be set' : false

// ── Helpers ───────────────────────────────────────────────────────────────────

function wsConnect(httpServer, headers = {}) {
  const { port } = httpServer.address()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    ws.once('open', () => resolve(ws))
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

/**
 * Collect messages until one of the given types arrives. Returns all collected messages up to and
 * including the matching one, or rejects on timeout.
 */
function waitForType(ws, targetType, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const msgs = []
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg)
      reject(new Error(`Timed out waiting for "${targetType}" (got: ${msgs.map((m) => m.type).join(', ')})`))
    }, timeoutMs)

    function onMsg(data) {
      const msg = JSON.parse(data.toString())
      msgs.push(msg)
      if (msg.type === targetType) {
        clearTimeout(timer)
        ws.removeListener('message', onMsg)
        resolve(msgs)
      }
    }
    ws.on('message', onMsg)
  })
}

async function apiRequest(baseUrl, method, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

// ── Test server setup ─────────────────────────────────────────────────────────

async function startTestServer(redis) {
  const app = express()
  app.use(express.json())

  const httpServer = http.createServer(app)
  const wss = createWsServer(httpServer, { redis, pingIntervalMs: 30_000, pongTimeoutMs: 10_000 })
  await wss._subscriberReady

  handler(app, { redis, wss })

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))

  return {
    baseUrl: `http://127.0.0.1:${httpServer.address().port}`,
    httpServer,
    wss,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise((res) => wss.close(res))
      await new Promise((res) => httpServer.close(res))
    },
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Waiting room WebSocket events (table room channel)', { skip }, () => {
  let server, redis

  const SESSION_A = 'wr-evt-session-a'
  const PLAYER_A = 'wr-evt-player-a'
  const SESSION_B = 'wr-evt-session-b'
  const PLAYER_B = 'wr-evt-player-b'

  before(async () => {
    redis = await getRedis()

    await redis.set(`session:${SESSION_A}`, JSON.stringify({ playerId: PLAYER_A, username: 'WrEvtHostA' }))
    await redis.set(`session:${SESSION_B}`, JSON.stringify({ playerId: PLAYER_B, username: 'WrEvtPlayerB' }))

    server = await startTestServer(redis)
  })

  after(async () => {
    await server.close()

    await redis.del(`session:${SESSION_A}`)
    await redis.del(`session:${SESSION_B}`)

    await closeRedis()
  })

  it('SEAT_VACATED is broadcast to the table room when a player leaves a waiting table', { timeout: 15000 }, async () => {
    // Create a table and have both players sit
    const createRes = await apiRequest(
      server.baseUrl,
      'POST',
      '/api/tables',
      { name: 'WR Leave Test' },
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )
    assert.equal(createRes.status, 201)
    const { tableId } = createRes.body

    await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/sit`,
      { seat: 'north' },
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )
    await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/sit`,
      { seat: 'east' },
      { 'x-session-id': SESSION_B, 'x-player-id': PLAYER_B },
    )

    // PLAYER_A connects to the table room (simulates the "Waiting for players" screen)
    const ws = await wsConnect(server.httpServer, { 'x-session-id': SESSION_A })
    ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
    await waitForType(ws, 'JOINED')

    const eventPromise = waitForType(ws, 'SEAT_VACATED')

    // PLAYER_B clicks Leave Table
    const leaveRes = await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/leave`,
      null,
      { 'x-session-id': SESSION_B, 'x-player-id': PLAYER_B },
    )
    assert.equal(leaveRes.status, 200)

    const msgs = await eventPromise
    const evt = msgs.find((m) => m.type === 'SEAT_VACATED')
    assert.ok(evt, 'SEAT_VACATED event should be received by players in the table room')
    assert.equal(evt.payload.seat, 'east', 'vacated seat should be east')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)

    ws.close()
    await waitClose(ws)
  })

  it('SEAT_TAKEN is broadcast to the table room when a player sits at a waiting table', { timeout: 15000 }, async () => {
    // Create a table and have PLAYER_A sit first
    const createRes = await apiRequest(
      server.baseUrl,
      'POST',
      '/api/tables',
      { name: 'WR Join Test' },
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )
    assert.equal(createRes.status, 201)
    const { tableId } = createRes.body

    await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/sit`,
      { seat: 'north' },
      { 'x-session-id': SESSION_A, 'x-player-id': PLAYER_A },
    )

    // PLAYER_A connects to the table room
    const ws = await wsConnect(server.httpServer, { 'x-session-id': SESSION_A })
    ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
    await waitForType(ws, 'JOINED')

    const eventPromise = waitForType(ws, 'SEAT_TAKEN')

    // PLAYER_B sits at the table
    const sitRes = await apiRequest(
      server.baseUrl,
      'POST',
      `/api/tables/${tableId}/sit`,
      { seat: 'south' },
      { 'x-session-id': SESSION_B, 'x-player-id': PLAYER_B },
    )
    assert.equal(sitRes.status, 200)

    const msgs = await eventPromise
    const evt = msgs.find((m) => m.type === 'SEAT_TAKEN')
    assert.ok(evt, 'SEAT_TAKEN event should be received by players in the table room')
    assert.equal(evt.payload.seat, 'south', 'taken seat should be south')

    // Cleanup
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)

    ws.close()
    await waitClose(ws)
  })
})
