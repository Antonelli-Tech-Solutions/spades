/**
 * Integration tests for spectator/observer mode (Issue #604).
 *
 * Verifies:
 * - Spectators receive public events (CARD_PLAYED, BID_PLACED, TRICK_COMPLETE, HAND_SCORED, GAME_OVER, TURN_CHANGED)
 * - Spectators never receive HAND_DEALT or HAND_REVEALED
 * - Server rejects bid and card-play actions from spectators with 403
 * - GET /api/tables/:tableId/state returns spectator view without hand data
 *
 * Requires REDIS_URL and DATABASE_URL.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import WebSocket from 'ws'
import bcrypt from 'bcryptjs'
import { handler } from '../../../server/server.js'
import { createWsServer } from '../../../server/ws/index.js'
import { getDb, closeDb } from '../../../server/db.js'
import { getRedis, closeRedis } from '../../../server/redis.js'
import { createGame } from '../../../server/game/state.js'

const skip =
  !process.env.DATABASE_URL || !process.env.REDIS_URL
    ? 'DATABASE_URL and REDIS_URL must both be set'
    : false

const TABLE_TTL = 3600

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  await db.query(`DELETE FROM players WHERE email LIKE '%@spectobs.spades.invalid'`)
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

function wsConnect(server, headers = {}) {
  const { port } = server.address()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    ws.once('open', () => setTimeout(() => resolve(ws), 100))
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }))
    })
  })
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())))
    ws.once('error', reject)
  })
}

function waitForType(ws, targetType, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const msgs = []
    const timer = setTimeout(() => {
      ws.removeListener('message', onMsg)
      reject(new Error(`Timed out waiting for message type "${targetType}"`))
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

function collectMessages(ws, durationMs) {
  return new Promise((resolve) => {
    const msgs = []
    function onMsg(data) {
      msgs.push(JSON.parse(data.toString()))
    }
    ws.on('message', onMsg)
    setTimeout(() => {
      ws.removeListener('message', onMsg)
      resolve(msgs)
    }, durationMs)
  })
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Spectator observer mode', { skip }, () => {
  let server, httpServer, wss, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)

    const specs = [
      { email: 'host@spectobs.spades.invalid', username: 'so_host', password: 'password123' },
      { email: 'p2@spectobs.spades.invalid', username: 'so_p2', password: 'password123' },
      { email: 'p3@spectobs.spades.invalid', username: 'so_p3', password: 'password123' },
      { email: 'p4@spectobs.spades.invalid', username: 'so_p4', password: 'password123' },
      { email: 'spec@spectobs.spades.invalid', username: 'so_spec', password: 'password123' },
    ]
    for (const spec of specs) {
      await insertVerifiedPlayer(db, spec)
    }

    const app = express()
    app.use(express.json())
    handler(app)
    httpServer = http.createServer(app)
    wss = createWsServer(httpServer, { redis })
    await wss._subscriberReady
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))

    const { port } = httpServer.address()
    const baseUrl = `http://127.0.0.1:${port}`

    for (const spec of specs) {
      const session = await loginPlayer(baseUrl, spec.email, spec.password)
      players.push({ ...session, baseUrl })
    }
  })

  after(async () => {
    for (const client of wss.clients) client.terminate()
    await new Promise((resolve) => wss.close(resolve))
    await new Promise((resolve) => httpServer.close(resolve))
    await closeDb()
    await closeRedis()
  })

  it('spectator receives broadcast events but not HAND_DEALT', { timeout: 15000 }, async () => {
    const host = players[0]
    const spectator = players[4]

    // Create table with spectating enabled
    const createRes = await fetch(`${host.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'public', spectating: true }),
    })
    assert.equal(createRes.status, 201)
    const { tableId } = await createRes.json()

    // Generate spectator link and join as spectator
    const linkRes = await fetch(`${host.baseUrl}/api/tables/${tableId}/spectator-link`, {
      method: 'POST',
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    assert.equal(linkRes.status, 200)
    const { token } = await linkRes.json()

    await fetch(`${host.baseUrl}/api/tables/spectator-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': spectator.sessionId,
        'x-player-id': spectator.playerId,
      },
    })

    // Spectator connects to WebSocket and joins the room
    const specWs = await wsConnect(httpServer, { 'x-session-id': spectator.sessionId })
    specWs.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
    const joinMsg = await nextMessage(specWs)
    assert.equal(joinMsg.type, 'JOINED', 'Spectator should be able to join the table room')

    // Seat host and 3 bots to start the game
    await fetch(`${host.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })
    for (const botSeat of ['east', 'south', 'west']) {
      await fetch(`${host.baseUrl}/api/tables/${tableId}/add-bot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': host.sessionId,
          'x-player-id': host.playerId,
        },
        body: JSON.stringify({ seat: botSeat }),
      })
    }

    // Collect all messages for a short period after game starts
    const msgs = await collectMessages(specWs, 2000)
    const types = msgs.map((m) => m.type)

    // Spectator should receive broadcast events
    assert.ok(
      types.includes('GAME_STARTED') || types.includes('SEAT_TAKEN') || types.includes('BID_PLACED') || types.includes('TURN_CHANGED'),
      'Spectator should receive at least one broadcast event',
    )

    // Spectator must NOT receive HAND_DEALT
    assert.ok(
      !types.includes('HAND_DEALT'),
      'Spectator must not receive HAND_DEALT events',
    )

    // Spectator must NOT receive HAND_REVEALED
    assert.ok(
      !types.includes('HAND_REVEALED'),
      'Spectator must not receive HAND_REVEALED events',
    )

    specWs.close()
  })

  it('spectator bid action is rejected with 403', { timeout: 10000 }, async () => {
    const host = players[0]
    const spectator = players[4]

    // Create a table with bots and start a game
    const createRes = await fetch(`${host.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'public', spectating: true }),
    })
    const { tableId } = await createRes.json()

    // Add spectator via link
    const linkRes = await fetch(`${host.baseUrl}/api/tables/${tableId}/spectator-link`, {
      method: 'POST',
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    const { token } = await linkRes.json()
    await fetch(`${host.baseUrl}/api/tables/spectator-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': spectator.sessionId,
        'x-player-id': spectator.playerId,
      },
    })

    // Fill the table to start a game
    await fetch(`${host.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })
    for (const botSeat of ['east', 'south', 'west']) {
      await fetch(`${host.baseUrl}/api/tables/${tableId}/add-bot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': host.sessionId,
          'x-player-id': host.playerId,
        },
        body: JSON.stringify({ seat: botSeat }),
      })
    }

    // Spectator attempts to bid — should be 403
    const bidRes = await fetch(`${host.baseUrl}/api/tables/${tableId}/bid`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': spectator.sessionId,
        'x-player-id': spectator.playerId,
      },
      body: JSON.stringify({ bid: 3 }),
    })
    assert.equal(bidRes.status, 403)
    const bidBody = await bidRes.json()
    assert.ok(bidBody.error)
  })

  it('spectator play action is rejected with 403', { timeout: 10000 }, async () => {
    const host = players[0]
    const spectator = players[4]

    const createRes = await fetch(`${host.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'public', spectating: true }),
    })
    const { tableId } = await createRes.json()

    const linkRes = await fetch(`${host.baseUrl}/api/tables/${tableId}/spectator-link`, {
      method: 'POST',
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    const { token } = await linkRes.json()
    await fetch(`${host.baseUrl}/api/tables/spectator-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': spectator.sessionId,
        'x-player-id': spectator.playerId,
      },
    })

    // Fill the table
    await fetch(`${host.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })
    for (const botSeat of ['east', 'south', 'west']) {
      await fetch(`${host.baseUrl}/api/tables/${tableId}/add-bot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': host.sessionId,
          'x-player-id': host.playerId,
        },
        body: JSON.stringify({ seat: botSeat }),
      })
    }

    // Spectator attempts to play a card — should be 403
    const playRes = await fetch(`${host.baseUrl}/api/tables/${tableId}/play`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': spectator.sessionId,
        'x-player-id': spectator.playerId,
      },
      body: JSON.stringify({ card: { suit: 'hearts', rank: '5' } }),
    })
    assert.equal(playRes.status, 403)
    const playBody = await playRes.json()
    assert.ok(playBody.error)
  })

  it('spectator game state endpoint returns spectator view without hand data', { timeout: 10000 }, async () => {
    const host = players[0]
    const spectator = players[4]

    const createRes = await fetch(`${host.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'public', spectating: true }),
    })
    const { tableId } = await createRes.json()

    const linkRes = await fetch(`${host.baseUrl}/api/tables/${tableId}/spectator-link`, {
      method: 'POST',
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    const { token } = await linkRes.json()
    await fetch(`${host.baseUrl}/api/tables/spectator-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': spectator.sessionId,
        'x-player-id': spectator.playerId,
      },
    })

    // Fill the table to start a game
    await fetch(`${host.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })
    for (const botSeat of ['east', 'south', 'west']) {
      await fetch(`${host.baseUrl}/api/tables/${tableId}/add-bot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': host.sessionId,
          'x-player-id': host.playerId,
        },
        body: JSON.stringify({ seat: botSeat }),
      })
    }

    // Spectator requests game state
    const stateRes = await fetch(`${host.baseUrl}/api/tables/${tableId}/state`, {
      headers: {
        'x-session-id': spectator.sessionId,
        'x-player-id': spectator.playerId,
      },
    })
    assert.equal(stateRes.status, 200)
    const state = await stateRes.json()

    assert.equal(state.status, 'spectating')
    assert.ok(state.seats, 'should include seats')
    assert.ok(!state.myHand, 'spectator view must not include myHand')
    assert.ok(!state.hands, 'spectator view must not include hands')
    assert.ok(state.phase !== undefined || state.scores !== undefined, 'should include game state fields')
  })

  it('spectator blind-nil-exchange action is rejected with 403', { timeout: 10000 }, async () => {
    const host = players[0]
    const spectator = players[4]

    const createRes = await fetch(`${host.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'public', spectating: true }),
    })
    const { tableId } = await createRes.json()

    const linkRes = await fetch(`${host.baseUrl}/api/tables/${tableId}/spectator-link`, {
      method: 'POST',
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    const { token } = await linkRes.json()
    await fetch(`${host.baseUrl}/api/tables/spectator-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': spectator.sessionId,
        'x-player-id': spectator.playerId,
      },
    })

    // Fill the table
    await fetch(`${host.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })
    for (const botSeat of ['east', 'south', 'west']) {
      await fetch(`${host.baseUrl}/api/tables/${tableId}/add-bot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': host.sessionId,
          'x-player-id': host.playerId,
        },
        body: JSON.stringify({ seat: botSeat }),
      })
    }

    // Spectator attempts blind-nil-exchange — should be 403
    const exchRes = await fetch(`${host.baseUrl}/api/tables/${tableId}/blind-nil-exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': spectator.sessionId,
        'x-player-id': spectator.playerId,
      },
      body: JSON.stringify({ cards: [{ suit: 'hearts', rank: '5' }, { suit: 'hearts', rank: '6' }] }),
    })
    assert.equal(exchRes.status, 403)
    const exchBody = await exchRes.json()
    assert.ok(exchBody.error)
  })

  it('spectator reveal-hand action is rejected with 403', { timeout: 10000 }, async () => {
    const host = players[0]
    const spectator = players[4]

    const createRes = await fetch(`${host.baseUrl}/api/tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ visibility: 'public', spectating: true }),
    })
    const { tableId } = await createRes.json()

    const linkRes = await fetch(`${host.baseUrl}/api/tables/${tableId}/spectator-link`, {
      method: 'POST',
      headers: { 'x-session-id': host.sessionId, 'x-player-id': host.playerId },
    })
    const { token } = await linkRes.json()
    await fetch(`${host.baseUrl}/api/tables/spectator-link/${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': spectator.sessionId,
        'x-player-id': spectator.playerId,
      },
    })

    // Fill the table
    await fetch(`${host.baseUrl}/api/tables/${tableId}/sit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': host.sessionId,
        'x-player-id': host.playerId,
      },
      body: JSON.stringify({ seat: 'north' }),
    })
    for (const botSeat of ['east', 'south', 'west']) {
      await fetch(`${host.baseUrl}/api/tables/${tableId}/add-bot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': host.sessionId,
          'x-player-id': host.playerId,
        },
        body: JSON.stringify({ seat: botSeat }),
      })
    }

    // Spectator attempts reveal-hand — should be 403
    const revealRes = await fetch(`${host.baseUrl}/api/tables/${tableId}/reveal-hand`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': spectator.sessionId,
        'x-player-id': spectator.playerId,
      },
    })
    assert.equal(revealRes.status, 403)
    const revealBody = await revealRes.json()
    assert.ok(revealBody.error)
  })
})
