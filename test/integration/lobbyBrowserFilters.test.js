/**
 * Integration tests: public lobby browser filters (#599)
 *
 * GET /api/lobby/tables supports two optional query params:
 *   - hasSeats=true      → only tables with at least one open (null) seat
 *   - search=<string>    → substring match against the table name
 *
 * Filters compose — both may be active simultaneously.
 *
 * The endpoint only returns public, waiting tables (friends-only, private, and
 * in-progress tables are excluded regardless of filters), preserving the
 * existing public-lobby contract.
 *
 * Requires REDIS_URL and DATABASE_URL.
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { handler } from '../../server/server.js'
import { getRedis, closeRedis } from '../../server/redis.js'
import { getDb, closeDb } from '../../server/db.js'
import { createSession } from '../../server/auth/session.js'

const skip =
  !process.env.DATABASE_URL || !process.env.REDIS_URL
    ? 'DATABASE_URL and REDIS_URL must both be set'
    : false

const LOBBY_PATH = '/api/lobby/tables'

// ── Test server helpers ──────────────────────────────────────────────────────

async function startTestServer() {
  const app = express()
  app.use(express.json())
  handler(app)

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      })
    })
  })
}

async function apiGet(baseUrl, path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...headers },
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

// ── DB helpers ───────────────────────────────────────────────────────────────

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
  await db.query(`DELETE FROM players WHERE email LIKE '%@lobbyfilter.test.spades.invalid'`)
}

async function insertTestPlayer(db, { email, username }) {
  const result = await db.query(
    `INSERT INTO players (email, username, password_hash, is_verified)
     VALUES ($1, $2, 'hash', TRUE) RETURNING id`,
    [email, username],
  )
  return result.rows[0].id
}

// ── Redis table helpers ──────────────────────────────────────────────────────

const TABLE_TTL = 3600

function makeTable(overrides = {}) {
  const base = {
    tableId: `lobbyfilter-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    hostPlayerId: 'host-player-id',
    name: null,
    seats: { north: null, east: null, south: null, west: null },
    observers: [],
    status: 'waiting',
    gameId: null,
    createdAt: new Date().toISOString(),
    visibility: 'public',
    joinPolicy: 'open',
    spectating: true,
  }
  return { ...base, ...overrides }
}

async function writeTable(redis, table, createdKeys) {
  await redis.set(`table:${table.tableId}`, JSON.stringify(table), { EX: TABLE_TTL })
  if (table.visibility === 'public') {
    await redis.hSet(
      'lobby:tables',
      table.tableId,
      JSON.stringify({
        tableId: table.tableId,
        hostPlayerId: table.hostPlayerId,
        name: table.name,
        status: table.status,
      }),
    )
  }
  await redis.hSet(
    'lobby:all',
    table.tableId,
    JSON.stringify({
      tableId: table.tableId,
      hostPlayerId: table.hostPlayerId,
      name: table.name,
      status: table.status,
    }),
  )
  createdKeys.push(table.tableId)
  return table
}

async function cleanupTables(redis, tableIds) {
  for (const tableId of tableIds) {
    await redis.del(`table:${tableId}`)
    await redis.hDel('lobby:tables', tableId)
    await redis.hDel('lobby:all', tableId)
  }
}

function findById(tables, tableId) {
  return tables.find((t) => t.tableId === tableId)
}

function idsOf(tables) {
  return tables.map((t) => t.tableId).sort()
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('GET /api/lobby/tables — public lobby filters (#599)', { skip }, () => {
  let server
  let redis
  let db
  let hostId
  let viewerId
  let viewerSession
  const tableIdsToClean = []

  before(async () => {
    redis = await getRedis()
    db = getDb()
    await resetTestSchema(db)

    hostId = await insertTestPlayer(db, {
      email: 'host@lobbyfilter.test.spades.invalid',
      username: 'LobbyFilterHost',
    })
    viewerId = await insertTestPlayer(db, {
      email: 'viewer@lobbyfilter.test.spades.invalid',
      username: 'LobbyFilterViewer',
    })

    viewerSession = await createSession(redis, {
      playerId: viewerId,
      email: 'viewer@lobbyfilter.test.spades.invalid',
      username: 'LobbyFilterViewer',
    })

    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    await cleanupTables(redis, tableIdsToClean)
    await redis.del(`session:${viewerSession}`)
    await resetTestSchema(db)
    await closeDb()
    await closeRedis()
  })

  beforeEach(async () => {
    // Each test seeds its own tables; ensure the lobby index is clean across tests.
    await cleanupTables(redis, tableIdsToClean.splice(0))
  })

  const authHeaders = () => ({
    'x-session-id': viewerSession,
    'x-player-id': viewerId,
  })

  // ── Baseline (no filters) ─────────────────────────────────────────────────

  describe('Baseline behavior (no filter params)', () => {
    it('returns all public waiting tables with no filter params', { timeout: 10000 }, async () => {
      const t1 = await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'Alpha' }), tableIdsToClean)
      const t2 = await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'Bravo' }), tableIdsToClean)

      const { status, body } = await apiGet(server.baseUrl, LOBBY_PATH, authHeaders())

      assert.equal(status, 200)
      assert.ok(Array.isArray(body.tables), 'response.tables must be an array')
      assert.ok(findById(body.tables, t1.tableId), 'Alpha must be returned')
      assert.ok(findById(body.tables, t2.tableId), 'Bravo must be returned')
    })

    it('does not return friends-only tables', { timeout: 10000 }, async () => {
      const fo = await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'FriendsOnlyTable',
          visibility: 'friends-only',
          joinPolicy: 'friends-only',
        }),
        tableIdsToClean,
      )

      const { status, body } = await apiGet(server.baseUrl, LOBBY_PATH, authHeaders())
      assert.equal(status, 200)
      assert.equal(findById(body.tables, fo.tableId), undefined, 'friends-only table must be excluded from public lobby')
    })

    it('does not return private tables', { timeout: 10000 }, async () => {
      const priv = await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'PrivateTable',
          visibility: 'private',
          joinPolicy: 'invite-only',
        }),
        tableIdsToClean,
      )

      const { status, body } = await apiGet(server.baseUrl, LOBBY_PATH, authHeaders())
      assert.equal(status, 200)
      assert.equal(findById(body.tables, priv.tableId), undefined, 'private table must not appear in the public lobby')
    })
  })

  // ── Auth ──────────────────────────────────────────────────────────────────

  describe('Authentication', () => {
    it('rejects unauthenticated requests with 401', { timeout: 10000 }, async () => {
      const { status } = await apiGet(server.baseUrl, LOBBY_PATH)
      assert.equal(status, 401, 'missing session must produce 401')
    })
  })

  // ── hasSeats filter ───────────────────────────────────────────────────────

  describe('?hasSeats=true filter', () => {
    it('excludes tables with all four seats filled', { timeout: 10000 }, async () => {
      const open = await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'OpenTable',
          seats: { north: hostId, east: null, south: null, west: null },
        }),
        tableIdsToClean,
      )
      const full = await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'FullTable',
          seats: { north: hostId, east: 'p2', south: 'p3', west: 'p4' },
        }),
        tableIdsToClean,
      )

      const { status, body } = await apiGet(
        server.baseUrl,
        `${LOBBY_PATH}?hasSeats=true`,
        authHeaders(),
      )

      assert.equal(status, 200)
      assert.ok(findById(body.tables, open.tableId), 'table with open seats must be included')
      assert.equal(findById(body.tables, full.tableId), undefined, 'full table must be excluded when hasSeats=true')
    })

    it('includes a table that has exactly one open seat', { timeout: 10000 }, async () => {
      const nearlyFull = await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'NearlyFull',
          seats: { north: hostId, east: 'p2', south: 'p3', west: null },
        }),
        tableIdsToClean,
      )

      const { status, body } = await apiGet(
        server.baseUrl,
        `${LOBBY_PATH}?hasSeats=true`,
        authHeaders(),
      )

      assert.equal(status, 200)
      const t = findById(body.tables, nearlyFull.tableId)
      assert.ok(t, 'table with one open seat must be included')
      assert.equal(t.seatsAvailable, 1, 'seatsAvailable should reflect the number of open seats')
    })

    it('counts bot-occupied seats as filled (bots are not "open")', { timeout: 10000 }, async () => {
      const allBots = await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'AllBotsButHost',
          seats: { north: hostId, east: 'bot:east', south: 'bot:south', west: 'bot:west' },
        }),
        tableIdsToClean,
      )

      const { status, body } = await apiGet(
        server.baseUrl,
        `${LOBBY_PATH}?hasSeats=true`,
        authHeaders(),
      )

      assert.equal(status, 200)
      assert.equal(
        findById(body.tables, allBots.tableId),
        undefined,
        'bot-filled table has no open seats and must be excluded',
      )
    })

    it('hasSeats=false (or omitted) returns tables regardless of seat availability', { timeout: 10000 }, async () => {
      const full = await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'FullNoFilter',
          seats: { north: hostId, east: 'p2', south: 'p3', west: 'p4' },
        }),
        tableIdsToClean,
      )

      const { body: bodyOmitted } = await apiGet(server.baseUrl, LOBBY_PATH, authHeaders())
      assert.ok(findById(bodyOmitted.tables, full.tableId), 'full table must be included when hasSeats is omitted')

      const { body: bodyFalse } = await apiGet(
        server.baseUrl,
        `${LOBBY_PATH}?hasSeats=false`,
        authHeaders(),
      )
      assert.ok(findById(bodyFalse.tables, full.tableId), 'full table must be included when hasSeats=false')
    })
  })

  // ── search filter ────────────────────────────────────────────────────────

  describe('?search=<string> filter', () => {
    it('returns only tables whose name contains the substring (case-insensitive)', { timeout: 10000 }, async () => {
      const hit1 = await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'Sunday Night Spades' }), tableIdsToClean)
      const hit2 = await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'spades friday' }), tableIdsToClean)
      const miss = await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'Hearts Corner' }), tableIdsToClean)

      const { status, body } = await apiGet(
        server.baseUrl,
        `${LOBBY_PATH}?search=spades`,
        authHeaders(),
      )

      assert.equal(status, 200)
      assert.ok(findById(body.tables, hit1.tableId), 'mixed-case name "Sunday Night Spades" must match search=spades')
      assert.ok(findById(body.tables, hit2.tableId), 'lowercase name matching search should appear')
      assert.equal(findById(body.tables, miss.tableId), undefined, 'non-matching name must be excluded')
    })

    it('matches as a substring (not just prefix or whole-word)', { timeout: 10000 }, async () => {
      const middle = await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'My Awesome Table' }), tableIdsToClean)

      const { status, body } = await apiGet(
        server.baseUrl,
        `${LOBBY_PATH}?search=awesome`,
        authHeaders(),
      )

      assert.equal(status, 200)
      assert.ok(findById(body.tables, middle.tableId), 'substring match in the middle of the name should succeed')
    })

    it('returns no tables when search matches nothing', { timeout: 10000 }, async () => {
      await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'Alpha Table' }), tableIdsToClean)
      await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'Bravo Table' }), tableIdsToClean)

      const { status, body } = await apiGet(
        server.baseUrl,
        `${LOBBY_PATH}?search=zzzz-no-match-zzzz`,
        authHeaders(),
      )

      assert.equal(status, 200)
      assert.ok(Array.isArray(body.tables))
      assert.equal(body.tables.length, 0, 'no tables should match an unknown substring')
    })

    it('treats empty search as no filter (returns all public waiting tables)', { timeout: 10000 }, async () => {
      const a = await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'AlphaE' }), tableIdsToClean)
      const b = await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'BravoE' }), tableIdsToClean)

      const { status, body } = await apiGet(
        server.baseUrl,
        `${LOBBY_PATH}?search=`,
        authHeaders(),
      )

      assert.equal(status, 200)
      assert.ok(findById(body.tables, a.tableId), 'empty search must not filter out tables')
      assert.ok(findById(body.tables, b.tableId))
    })

    it('excludes unnamed (name=null) tables when a search term is provided', { timeout: 10000 }, async () => {
      const named = await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'NamedFoo' }), tableIdsToClean)
      const unnamed = await writeTable(redis, makeTable({ hostPlayerId: hostId, name: null }), tableIdsToClean)

      const { status, body } = await apiGet(
        server.baseUrl,
        `${LOBBY_PATH}?search=foo`,
        authHeaders(),
      )

      assert.equal(status, 200)
      assert.ok(findById(body.tables, named.tableId), 'named table matching the term must be included')
      assert.equal(
        findById(body.tables, unnamed.tableId),
        undefined,
        'unnamed tables cannot match any search term and must be excluded',
      )
    })

    it('handles special regex characters in search without throwing (literal substring match)', { timeout: 10000 }, async () => {
      const special = await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'Bob\'s (Fun) Table [2026]' }), tableIdsToClean)
      const other = await writeTable(redis, makeTable({ hostPlayerId: hostId, name: 'Plain Table' }), tableIdsToClean)

      const { status, body } = await apiGet(
        server.baseUrl,
        `${LOBBY_PATH}?search=${encodeURIComponent('(Fun)')}`,
        authHeaders(),
      )

      assert.equal(status, 200)
      assert.ok(findById(body.tables, special.tableId), 'literal parenthesized substring must match')
      assert.equal(findById(body.tables, other.tableId), undefined, 'non-matching table must not be included')
    })
  })

  // ── Composition of filters ───────────────────────────────────────────────

  describe('Filters compose (hasSeats=true & search=<term>)', () => {
    it('returns only tables that match both the search term AND have open seats', { timeout: 10000 }, async () => {
      // Matches search AND has seats → should appear
      const match = await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'Spades Championship',
          seats: { north: hostId, east: null, south: null, west: null },
        }),
        tableIdsToClean,
      )
      // Matches search but full → should NOT appear (fails hasSeats)
      const matchFull = await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'Spades Pro League',
          seats: { north: hostId, east: 'p2', south: 'p3', west: 'p4' },
        }),
        tableIdsToClean,
      )
      // Has seats but doesn't match search → should NOT appear
      const hasSeatsNoMatch = await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'Hearts Club',
          seats: { north: hostId, east: null, south: null, west: null },
        }),
        tableIdsToClean,
      )
      // Neither matches — should NOT appear
      const neither = await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'Bridge Table',
          seats: { north: hostId, east: 'p2', south: 'p3', west: 'p4' },
        }),
        tableIdsToClean,
      )

      const { status, body } = await apiGet(
        server.baseUrl,
        `${LOBBY_PATH}?hasSeats=true&search=spades`,
        authHeaders(),
      )

      assert.equal(status, 200)
      assert.ok(findById(body.tables, match.tableId), 'match+open must be included')
      assert.equal(findById(body.tables, matchFull.tableId), undefined, 'match+full must be excluded (fails hasSeats)')
      assert.equal(findById(body.tables, hasSeatsNoMatch.tableId), undefined, 'open+no-match must be excluded (fails search)')
      assert.equal(findById(body.tables, neither.tableId), undefined, 'neither must be excluded')

      const returnedIds = idsOf(body.tables.filter((t) => tableIdsToClean.includes(t.tableId)))
      assert.deepEqual(returnedIds, [match.tableId].sort(), 'only the matching+open table should be returned among seeded tables')
    })

    it('applying both filters to an empty intersection returns an empty list', { timeout: 10000 }, async () => {
      await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'Only Spades Full',
          seats: { north: hostId, east: 'p2', south: 'p3', west: 'p4' },
        }),
        tableIdsToClean,
      )

      const { status, body } = await apiGet(
        server.baseUrl,
        `${LOBBY_PATH}?hasSeats=true&search=spades`,
        authHeaders(),
      )

      assert.equal(status, 200)
      const seeded = body.tables.filter((t) => tableIdsToClean.includes(t.tableId))
      assert.deepEqual(seeded, [], 'no seeded tables should satisfy both filters')
    })
  })

  // ── Response shape ───────────────────────────────────────────────────────

  describe('Response shape', () => {
    it('each returned table includes tableId, name, seats, and seatsAvailable', { timeout: 10000 }, async () => {
      const t = await writeTable(
        redis,
        makeTable({
          hostPlayerId: hostId,
          name: 'Shape Test',
          seats: { north: hostId, east: null, south: null, west: null },
        }),
        tableIdsToClean,
      )

      const { status, body } = await apiGet(server.baseUrl, LOBBY_PATH, authHeaders())
      assert.equal(status, 200)

      const entry = findById(body.tables, t.tableId)
      assert.ok(entry, 'seeded table must be in the response')
      assert.equal(entry.tableId, t.tableId)
      assert.equal(entry.name, 'Shape Test')
      assert.ok(entry.seats, 'response entry must include seats')
      assert.equal(typeof entry.seatsAvailable, 'number', 'seatsAvailable must be a number')
      assert.equal(entry.seatsAvailable, 3, 'three seats open')
    })
  })
})
