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

async function startTestServer() {
  const app = express()
  app.use(express.json())
  handler(app)
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@hctest.spades.invalid'`)
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

async function createTable(baseUrl, player) {
  const res = await fetch(`${baseUrl}/api/tables`, {
    method: 'POST',
    headers: { 'x-session-id': player.sessionId, 'x-player-id': player.playerId },
  })
  const body = await res.json()
  return body.tableId
}

async function sitPlayer(baseUrl, tableId, player, seat) {
  const res = await fetch(`${baseUrl}/api/tables/${tableId}/sit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': player.sessionId,
      'x-player-id': player.playerId,
    },
    body: JSON.stringify({ seat }),
  })
  assert.equal(res.status, 200, `sit at ${seat} failed`)
}

function authHeaders(player) {
  return {
    'Content-Type': 'application/json',
    'x-session-id': player.sessionId,
    'x-player-id': player.playerId,
  }
}

// ---------- POST /api/tables/:tableId/assign-seat ----------

describe('POST /api/tables/:tableId/assign-seat', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `hcassign${i}@hctest.spades.invalid`,
        username: `hctest_assign${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `hcassign${i}@hctest.spades.invalid`,
        'password123',
      )
      players.push(data)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('host can assign a seated player to a different empty seat', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId, seat: 'south' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.seat, 'south')

    const table = JSON.parse(await redis.get(`table:${tableId}`))
    assert.equal(table.seats.south, players[1].playerId)
    assert.equal(table.seats.east, null)
  })

  it('host can assign an observer to a seat', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')

    // Player 1 joins as observer (join table without sitting)
    const joinRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/join`, {
      method: 'POST',
      headers: authHeaders(players[1]),
    })
    // If join endpoint exists, player becomes observer; otherwise skip this test
    if (joinRes.status !== 200) {
      // Player may auto-join; try sitting via assign-seat directly
    }

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId, seat: 'west' }),
    })
    // Accept 200 (success) — the endpoint should allow host to assign observers to seats
    assert.ok([200].includes(res.status), `expected 200, got ${res.status}`)
  })

  it('returns 403 when non-host tries to assign seat', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
      method: 'POST',
      headers: authHeaders(players[1]),
      body: JSON.stringify({ playerId: players[1].playerId, seat: 'south' }),
    })
    assert.equal(res.status, 403)
  })

  it('returns 401 without auth headers', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: players[1].playerId, seat: 'south' }),
    })
    assert.equal(res.status, 401)
  })

  it('returns 404 for non-existent table', { timeout: 10000 }, async () => {
    const res = await fetch(
      `${server.baseUrl}/api/tables/00000000-0000-0000-0000-000000000000/assign-seat`,
      {
        method: 'POST',
        headers: authHeaders(players[0]),
        body: JSON.stringify({ playerId: players[1].playerId, seat: 'south' }),
      },
    )
    assert.equal(res.status, 404)
  })

  it('returns 409 when target seat is already occupied', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')
    await sitPlayer(server.baseUrl, tableId, players[2], 'south')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId, seat: 'south' }),
    })
    assert.equal(res.status, 409)
  })

  it('returns 400 for invalid seat name', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId, seat: 'invalid' }),
    })
    assert.equal(res.status, 400)
  })

  it('returns 400 when playerId is missing', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ seat: 'south' }),
    })
    assert.equal(res.status, 400)
  })

  it('returns 400 when seat is missing', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId }),
    })
    assert.equal(res.status, 400)
  })

  it('rejects assign-seat when table is in playing status', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')
    await sitPlayer(server.baseUrl, tableId, players[2], 'south')
    await sitPlayer(server.baseUrl, tableId, players[3], 'west')

    // Table should now be in playing status
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId, seat: 'south' }),
    })
    // Should reject — seat assignment is pre-game only
    assert.ok([400, 409].includes(res.status), `expected 400 or 409, got ${res.status}`)
  })

  it('returns 404 when target player is not at the table', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/assign-seat`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[2].playerId, seat: 'south' }),
    })
    // Player 2 is not at the table — should return 404 or 400
    assert.ok([400, 404].includes(res.status), `expected 400 or 404, got ${res.status}`)
  })
})

// ---------- POST /api/tables/:tableId/kick ----------

describe('POST /api/tables/:tableId/kick', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `hckick${i}@hctest.spades.invalid`,
        username: `hctest_kick${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `hckick${i}@hctest.spades.invalid`,
        'password123',
      )
      players.push(data)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('host can kick a seated player from the table', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId }),
    })
    assert.equal(res.status, 200)

    const table = JSON.parse(await redis.get(`table:${tableId}`))
    assert.equal(table.seats.east, null, 'kicked player seat should be empty')
    const isObserver = table.observers.includes(players[1].playerId)
    assert.equal(isObserver, false, 'kicked player should not remain as observer')
  })

  it('returns 403 when non-host tries to kick a player', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')
    await sitPlayer(server.baseUrl, tableId, players[2], 'south')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
      method: 'POST',
      headers: authHeaders(players[1]),
      body: JSON.stringify({ playerId: players[2].playerId }),
    })
    assert.equal(res.status, 403)
  })

  it('returns 401 without auth headers', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: players[1].playerId }),
    })
    assert.equal(res.status, 401)
  })

  it('returns 404 for non-existent table', { timeout: 10000 }, async () => {
    const res = await fetch(
      `${server.baseUrl}/api/tables/00000000-0000-0000-0000-000000000000/kick`,
      {
        method: 'POST',
        headers: authHeaders(players[0]),
        body: JSON.stringify({ playerId: players[1].playerId }),
      },
    )
    assert.equal(res.status, 404)
  })

  it('returns 400 when playerId is missing', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400)
  })

  it('host cannot kick themselves', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[0].playerId }),
    })
    assert.ok([400, 403].includes(res.status), `expected 400 or 403, got ${res.status}`)
  })

  it('returns 404 when target player is not at the table', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[2].playerId }),
    })
    assert.ok([400, 404].includes(res.status), `expected 400 or 404, got ${res.status}`)
  })

  it('kicked player seat is freed and available for new players', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')

    // Kick player 1
    const kickRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId }),
    })
    assert.equal(kickRes.status, 200)

    // Player 2 should be able to sit in the freed seat
    await sitPlayer(server.baseUrl, tableId, players[2], 'east')
    const table = JSON.parse(await redis.get(`table:${tableId}`))
    assert.equal(table.seats.east, players[2].playerId)
  })

  it('rejects kick when table is in playing status', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')
    await sitPlayer(server.baseUrl, tableId, players[2], 'south')
    await sitPlayer(server.baseUrl, tableId, players[3], 'west')

    const table = JSON.parse(await redis.get(`table:${tableId}`))
    assert.equal(table.status, 'playing', 'table should be in playing status')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId }),
    })
    assert.equal(res.status, 409, 'kick should be rejected during active game')
  })

  it('kicking last non-host player keeps table alive with host', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId }),
    })
    assert.equal(res.status, 200)

    const table = JSON.parse(await redis.get(`table:${tableId}`))
    assert.ok(table, 'table should still exist after kicking non-host player')
    assert.equal(table.hostPlayerId, players[0].playerId)
  })
})

// ---------- POST /api/tables/:tableId/transfer-host ----------

describe('POST /api/tables/:tableId/transfer-host', { skip }, () => {
  let server, db, redis
  const players = []

  before(async () => {
    db = getDb()
    redis = await getRedis()
    await ensurePlayersTable(db)
    for (let i = 1; i <= 4; i++) {
      await insertVerifiedPlayer(db, {
        email: `hcxfer${i}@hctest.spades.invalid`,
        username: `hctest_xfer${i}`,
        password: 'password123',
      })
    }
    server = await startTestServer()
    for (let i = 1; i <= 4; i++) {
      const data = await loginPlayer(
        server.baseUrl,
        `hcxfer${i}@hctest.spades.invalid`,
        'password123',
      )
      players.push(data)
    }
  })

  after(async () => {
    await server.close()
    await closeDb()
    await closeRedis()
  })

  it('host can transfer host to another seated player', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId }),
    })
    assert.equal(res.status, 200)

    const table = JSON.parse(await redis.get(`table:${tableId}`))
    assert.equal(table.hostPlayerId, players[1].playerId, 'host should be transferred')
  })

  it('new host can perform host actions after transfer', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')
    await sitPlayer(server.baseUrl, tableId, players[2], 'south')

    // Transfer host to player 1
    const xferRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId }),
    })
    assert.equal(xferRes.status, 200)

    // New host (player 1) should be able to kick player 2
    const kickRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
      method: 'POST',
      headers: authHeaders(players[1]),
      body: JSON.stringify({ playerId: players[2].playerId }),
    })
    assert.equal(kickRes.status, 200)
  })

  it('old host loses host privileges after transfer', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')
    await sitPlayer(server.baseUrl, tableId, players[2], 'south')

    // Transfer host to player 1
    await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId }),
    })

    // Old host (player 0) should NOT be able to kick
    const kickRes = await fetch(`${server.baseUrl}/api/tables/${tableId}/kick`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[2].playerId }),
    })
    assert.equal(kickRes.status, 403)
  })

  it('returns 403 when non-host tries to transfer host', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
      method: 'POST',
      headers: authHeaders(players[1]),
      body: JSON.stringify({ playerId: players[1].playerId }),
    })
    assert.equal(res.status, 403)
  })

  it('returns 401 without auth headers', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: players[1].playerId }),
    })
    assert.equal(res.status, 401)
  })

  it('returns 404 for non-existent table', { timeout: 10000 }, async () => {
    const res = await fetch(
      `${server.baseUrl}/api/tables/00000000-0000-0000-0000-000000000000/transfer-host`,
      {
        method: 'POST',
        headers: authHeaders(players[0]),
        body: JSON.stringify({ playerId: players[1].playerId }),
      },
    )
    assert.equal(res.status, 404)
  })

  it('returns 400 when playerId is missing', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 400)
  })

  it('host cannot transfer to themselves', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[0].playerId }),
    })
    assert.ok([400].includes(res.status), `expected 400, got ${res.status}`)
  })

  it('cannot transfer host to a player not at the table', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[2].playerId }),
    })
    assert.ok([400, 404].includes(res.status), `expected 400 or 404, got ${res.status}`)
  })

  it('transfer-host works during playing status', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')
    await sitPlayer(server.baseUrl, tableId, players[2], 'south')
    await sitPlayer(server.baseUrl, tableId, players[3], 'west')

    // Table should now be in playing status
    const table = JSON.parse(await redis.get(`table:${tableId}`))
    assert.equal(table.status, 'playing', 'table should be in playing status')

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId }),
    })
    assert.equal(res.status, 200, 'transfer-host should work during game')

    const updated = JSON.parse(await redis.get(`table:${tableId}`))
    assert.equal(updated.hostPlayerId, players[1].playerId)
  })

  it('cannot transfer host to an observer (must be seated)', { timeout: 10000 }, async () => {
    const tableId = await createTable(server.baseUrl, players[0])
    await sitPlayer(server.baseUrl, tableId, players[0], 'north')
    await sitPlayer(server.baseUrl, tableId, players[1], 'east')

    // Player 1 stands → becomes observer
    await fetch(`${server.baseUrl}/api/tables/${tableId}/stand`, {
      method: 'POST',
      headers: authHeaders(players[1]),
    })

    const res = await fetch(`${server.baseUrl}/api/tables/${tableId}/transfer-host`, {
      method: 'POST',
      headers: authHeaders(players[0]),
      body: JSON.stringify({ playerId: players[1].playerId }),
    })
    assert.ok([400, 403].includes(res.status), `expected 400 or 403, got ${res.status}`)
  })
})
