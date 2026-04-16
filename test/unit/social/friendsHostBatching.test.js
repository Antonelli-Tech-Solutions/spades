/**
 * Unit tests for issue #669 — getFriends() host-friendship batching.
 *
 * Background: inside getFriends(), when enriching friends who are at
 * friends-only tables, the current implementation calls
 * isRequesterFriendOfHost(host) inside a for-loop with
 * `await` (eslint-disable no-await-in-loop). Each distinct friends-only host
 * triggers its own sequential DB round-trip — O(N_unique_hosts).
 *
 * The fix: collect the unique set of hostPlayerIds up front, resolve ALL
 * host friendships in a single batched query, then consult that precomputed
 * set synchronously inside the loop.
 *
 * These tests drive that refactor. They use a fake pg Pool whose `query`
 * method records every call, so we can assert that the number of
 * host-friendship queries does NOT grow with the number of unique
 * friends-only hosts.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getFriends } from '../../../server/social/friends.js'

// ── Fake pg Pool ──────────────────────────────────────────────────────────────
//
// Supports two call-shapes that getFriends is expected to use:
//   1) the friends-list query           (JOIN players p ON ...)
//   2) the host-friendship query        (FROM friendships ...)
//
// The host-friendship query can be EITHER:
//   a) scalar form — params[1] is a single host UUID (legacy per-host call)
//   b) batched form — params[1] is an array of host UUIDs
//
// The fake returns rows populated with every plausible column alias
// (host_id, friend_id, id, requester_id, addressee_id) so the test doesn't
// depend on which alias the implementation chooses.
function makeFakeDb({ friendsListRows, friendPairs }) {
  const calls = []
  const pairKey = (a, b) => [a, b].sort().join('::')
  const accepted = new Set(friendPairs.map(([a, b]) => pairKey(a, b)))
  const isFriendPair = (a, b) => accepted.has(pairKey(a, b))

  return {
    async query(sql, params) {
      calls.push({ sql, params })
      const lower = sql.toLowerCase()

      if (lower.includes('join players')) {
        return { rows: friendsListRows }
      }

      if (lower.includes('from friendships')) {
        const requester = params[0]
        const candidate = params[1]
        if (Array.isArray(candidate)) {
          const matches = candidate.filter((h) => isFriendPair(requester, h))
          return {
            rows: matches.map((id) => ({
              host_id: id,
              friend_id: id,
              id,
              requester_id: id,
              addressee_id: id,
            })),
          }
        }
        return { rows: isFriendPair(requester, candidate) ? [{ one: 1 }] : [] }
      }

      return { rows: [] }
    },
    calls,
    hostFriendshipQueryCount() {
      return calls.filter((c) => {
        const s = c.sql.toLowerCase()
        return s.includes('from friendships') && !s.includes('join players')
      }).length
    },
    allQueryCount() {
      return calls.length
    },
  }
}

function makeFakeRedis({ presences = {}, tables = {} } = {}) {
  return {
    async get(key) {
      if (key.startsWith('presence:')) {
        const id = key.slice('presence:'.length)
        const p = presences[id]
        return p ? JSON.stringify(p) : null
      }
      if (key.startsWith('table:')) {
        const id = key.slice('table:'.length)
        const t = tables[id]
        return t ? JSON.stringify(t) : null
      }
      return null
    },
  }
}

// ── Stable UUIDs for the test fixtures ────────────────────────────────────────
const ALICE = '00000000-0000-4000-8000-0000000000a1'
const BOB = '00000000-0000-4000-8000-0000000000b2'
const CHARLIE = '00000000-0000-4000-8000-0000000000c3'
const DIANA = '00000000-0000-4000-8000-0000000000d4'
const EVAN = '00000000-0000-4000-8000-0000000000e5'
const FRANK = '00000000-0000-4000-8000-0000000000f6'
const HOST_A = '00000000-0000-4000-8000-0000000000aa'
const HOST_B = '00000000-0000-4000-8000-0000000000bb'
const HOST_C = '00000000-0000-4000-8000-0000000000cc'
const HOST_D = '00000000-0000-4000-8000-0000000000dd'
const HOST_E = '00000000-0000-4000-8000-0000000000ee'

describe('getFriends — host-friendship batching (#669)', { timeout: 2000 }, () => {
  it('resolves host friendships for many distinct hosts in a single batched query', { timeout: 2000 }, async () => {
    // Alice has 5 friends, each at a different friends-only table with a different host.
    // HOST_A and HOST_B are Alice's friends; HOST_C, HOST_D, HOST_E are strangers.
    const friendsListRows = [
      { friend_id: BOB, username: 'bob', created_at: new Date('2026-01-01T00:00:00Z') },
      { friend_id: CHARLIE, username: 'charlie', created_at: new Date('2026-01-02T00:00:00Z') },
      { friend_id: DIANA, username: 'diana', created_at: new Date('2026-01-03T00:00:00Z') },
      { friend_id: EVAN, username: 'evan', created_at: new Date('2026-01-04T00:00:00Z') },
      { friend_id: FRANK, username: 'frank', created_at: new Date('2026-01-05T00:00:00Z') },
    ]
    const friendPairs = [
      [ALICE, BOB], [ALICE, CHARLIE], [ALICE, DIANA], [ALICE, EVAN], [ALICE, FRANK],
      [ALICE, HOST_A], [ALICE, HOST_B],
    ]
    const db = makeFakeDb({ friendsListRows, friendPairs })

    const presences = {
      [BOB]: { status: 'playing', tableId: 'tA' },
      [CHARLIE]: { status: 'playing', tableId: 'tB' },
      [DIANA]: { status: 'playing', tableId: 'tC' },
      [EVAN]: { status: 'playing', tableId: 'tD' },
      [FRANK]: { status: 'playing', tableId: 'tE' },
    }
    const tables = {
      tA: { tableId: 'tA', hostPlayerId: HOST_A, name: 'A Table', visibility: 'friends-only' },
      tB: { tableId: 'tB', hostPlayerId: HOST_B, name: 'B Table', visibility: 'friends-only' },
      tC: { tableId: 'tC', hostPlayerId: HOST_C, name: 'C Table', visibility: 'friends-only' },
      tD: { tableId: 'tD', hostPlayerId: HOST_D, name: 'D Table', visibility: 'friends-only' },
      tE: { tableId: 'tE', hostPlayerId: HOST_E, name: 'E Table', visibility: 'friends-only' },
    }
    const redis = makeFakeRedis({ presences, tables })

    const enriched = await getFriends(db, ALICE, { redis, requestingPlayerId: ALICE })

    // Correctness: names are disclosed iff host is Alice's friend.
    const byId = Object.fromEntries(enriched.map((f) => [f.playerId, f]))
    assert.equal(byId[BOB].tableInfo.tableName, 'A Table', 'HOST_A is Alice\'s friend — name disclosed')
    assert.equal(byId[CHARLIE].tableInfo.tableName, 'B Table', 'HOST_B is Alice\'s friend — name disclosed')
    assert.equal(byId[DIANA].tableInfo.tableName, null, 'HOST_C is not Alice\'s friend — name hidden')
    assert.equal(byId[EVAN].tableInfo.tableName, null, 'HOST_D is not Alice\'s friend — name hidden')
    assert.equal(byId[FRANK].tableInfo.tableName, null, 'HOST_E is not Alice\'s friend — name hidden')

    // Batching: 5 unique friends-only hosts should trigger at most one host-friendship query,
    // NOT five. This is the whole point of the issue.
    const hostQueries = db.hostFriendshipQueryCount()
    assert.ok(
      hostQueries <= 1,
      `expected ≤1 batched host-friendship query for 5 distinct hosts, got ${hostQueries}`,
    )
  })

  it('makes zero host-friendship queries when no friend is at a friends-only table', { timeout: 2000 }, async () => {
    // Only public tables and online/offline statuses — no host check required.
    const friendsListRows = [
      { friend_id: BOB, username: 'bob', created_at: new Date() },
      { friend_id: CHARLIE, username: 'charlie', created_at: new Date() },
      { friend_id: DIANA, username: 'diana', created_at: new Date() },
    ]
    const db = makeFakeDb({
      friendsListRows,
      friendPairs: [[ALICE, BOB], [ALICE, CHARLIE], [ALICE, DIANA]],
    })
    const presences = {
      [BOB]: { status: 'online', tableId: null },
      [CHARLIE]: { status: 'playing', tableId: 'pub' },
      // Diana has no presence key — offline.
    }
    const tables = {
      pub: { tableId: 'pub', hostPlayerId: HOST_A, name: 'Public Table', visibility: 'public' },
    }
    const redis = makeFakeRedis({ presences, tables })

    const enriched = await getFriends(db, ALICE, { redis, requestingPlayerId: ALICE })

    const byId = Object.fromEntries(enriched.map((f) => [f.playerId, f]))
    assert.equal(byId[BOB].presenceStatus, 'online')
    assert.equal(byId[BOB].tableInfo, null)
    assert.equal(byId[CHARLIE].presenceStatus, 'in-game')
    assert.equal(byId[CHARLIE].tableInfo.tableName, 'Public Table')
    assert.equal(byId[DIANA].presenceStatus, 'offline')
    assert.equal(byId[DIANA].tableInfo, null)

    assert.equal(
      db.hostFriendshipQueryCount(),
      0,
      'no friends-only host to resolve → zero host-friendship queries',
    )
  })

  it('does not issue a host-friendship query for a table the requester themselves hosts', { timeout: 2000 }, async () => {
    // Bob is at Alice's OWN friends-only table → self-host shortcut, no DB lookup needed.
    const friendsListRows = [
      { friend_id: BOB, username: 'bob', created_at: new Date() },
    ]
    const db = makeFakeDb({
      friendsListRows,
      friendPairs: [[ALICE, BOB]],
    })
    const presences = {
      [BOB]: { status: 'playing', tableId: 'self' },
    }
    const tables = {
      self: { tableId: 'self', hostPlayerId: ALICE, name: 'Alice Table', visibility: 'friends-only' },
    }
    const redis = makeFakeRedis({ presences, tables })

    const enriched = await getFriends(db, ALICE, { redis, requestingPlayerId: ALICE })

    const bob = enriched.find((f) => f.playerId === BOB)
    assert.equal(bob.presenceStatus, 'in-game')
    assert.equal(bob.tableInfo.tableName, 'Alice Table', 'requester hosts the table → name disclosed')

    assert.equal(
      db.hostFriendshipQueryCount(),
      0,
      'self-host needs no DB lookup — requester is trivially friend of themselves',
    )
  })

  it('disclosure is correct when many friends share the same friends-only host', { timeout: 2000 }, async () => {
    // Three friends all sitting at the same friends-only table hosted by a non-friend.
    const friendsListRows = [
      { friend_id: BOB, username: 'bob', created_at: new Date() },
      { friend_id: CHARLIE, username: 'charlie', created_at: new Date() },
      { friend_id: DIANA, username: 'diana', created_at: new Date() },
    ]
    const db = makeFakeDb({
      friendsListRows,
      friendPairs: [[ALICE, BOB], [ALICE, CHARLIE], [ALICE, DIANA]],
    })
    const presences = {
      [BOB]: { status: 'playing', tableId: 't1' },
      [CHARLIE]: { status: 'playing', tableId: 't1' },
      [DIANA]: { status: 'playing', tableId: 't1' },
    }
    const tables = {
      t1: { tableId: 't1', hostPlayerId: HOST_C, name: 'Secret', visibility: 'friends-only' },
    }
    const redis = makeFakeRedis({ presences, tables })

    const enriched = await getFriends(db, ALICE, { redis, requestingPlayerId: ALICE })

    for (const f of enriched) {
      assert.equal(f.presenceStatus, 'in-game')
      assert.equal(f.tableInfo.tableName, null, `host is stranger → name hidden for ${f.username}`)
    }

    assert.ok(
      db.hostFriendshipQueryCount() <= 1,
      'single shared host → at most one host-friendship query',
    )
  })

  it('correctly mixes disclosed, hidden, and self-host friends-only tables in one call', { timeout: 2000 }, async () => {
    // Exercises all three branches in a single getFriends call:
    //   - HOST_A is a friend of Alice (disclose)
    //   - HOST_C is a stranger (hide)
    //   - ALICE is her own host (disclose, no DB lookup)
    const friendsListRows = [
      { friend_id: BOB, username: 'bob', created_at: new Date() },
      { friend_id: CHARLIE, username: 'charlie', created_at: new Date() },
      { friend_id: DIANA, username: 'diana', created_at: new Date() },
    ]
    const friendPairs = [
      [ALICE, BOB], [ALICE, CHARLIE], [ALICE, DIANA],
      [ALICE, HOST_A],
    ]
    const db = makeFakeDb({ friendsListRows, friendPairs })
    const presences = {
      [BOB]: { status: 'playing', tableId: 'tA' },
      [CHARLIE]: { status: 'playing', tableId: 'tC' },
      [DIANA]: { status: 'playing', tableId: 'tSelf' },
    }
    const tables = {
      tA: { tableId: 'tA', hostPlayerId: HOST_A, name: 'Alpha', visibility: 'friends-only' },
      tC: { tableId: 'tC', hostPlayerId: HOST_C, name: 'Charlie', visibility: 'friends-only' },
      tSelf: { tableId: 'tSelf', hostPlayerId: ALICE, name: 'Mine', visibility: 'friends-only' },
    }
    const redis = makeFakeRedis({ presences, tables })

    const enriched = await getFriends(db, ALICE, { redis, requestingPlayerId: ALICE })
    const byId = Object.fromEntries(enriched.map((f) => [f.playerId, f]))

    assert.equal(byId[BOB].tableInfo.tableName, 'Alpha', 'HOST_A is friend → disclose')
    assert.equal(byId[CHARLIE].tableInfo.tableName, null, 'HOST_C is stranger → hide')
    assert.equal(byId[DIANA].tableInfo.tableName, 'Mine', 'self-host → disclose')

    assert.ok(
      db.hostFriendshipQueryCount() <= 1,
      `expected ≤1 host-friendship query for two non-self hosts, got ${db.hostFriendshipQueryCount()}`,
    )
  })

  it('total DB query count does not scale with the number of unique friends-only hosts', { timeout: 2000 }, async () => {
    // The core performance guarantee of the fix: adding more unique hosts
    // should NOT add more DB queries. We run the function with 1 unique host
    // and again with 6 unique hosts and assert the query counts are equal.
    function scenario(numHosts) {
      const friendIds = [BOB, CHARLIE, DIANA, EVAN, FRANK, HOST_E].slice(0, numHosts)
      const hostIds = [HOST_A, HOST_B, HOST_C, HOST_D, HOST_E, HOST_A].slice(0, numHosts)
      const friendsListRows = friendIds.map((id, i) => ({
        friend_id: id, username: `u${i}`, created_at: new Date(),
      }))
      const db = makeFakeDb({
        friendsListRows,
        friendPairs: friendIds.map((id) => [ALICE, id]),
      })
      const presences = {}
      const tables = {}
      friendIds.forEach((id, i) => {
        const tid = `tbl${i}`
        presences[id] = { status: 'playing', tableId: tid }
        tables[tid] = {
          tableId: tid,
          hostPlayerId: hostIds[i],
          name: `T${i}`,
          visibility: 'friends-only',
        }
      })
      const redis = makeFakeRedis({ presences, tables })
      return { db, redis }
    }

    const one = scenario(1)
    const many = scenario(6)

    await getFriends(one.db, ALICE, { redis: one.redis, requestingPlayerId: ALICE })
    await getFriends(many.db, ALICE, { redis: many.redis, requestingPlayerId: ALICE })

    const oneCount = one.db.hostFriendshipQueryCount()
    const manyCount = many.db.hostFriendshipQueryCount()

    assert.equal(
      manyCount,
      oneCount,
      `host-friendship query count must be constant wrt unique-host count (one=${oneCount}, many=${manyCount})`,
    )
    assert.ok(manyCount <= 1, `expected at most 1 host-friendship query, got ${manyCount}`)
  })

  it('uses the requestingPlayerId (not the target playerId) when resolving host friendships', { timeout: 2000 }, async () => {
    // If user A is viewing user B's friends list, host disclosure must be
    // judged against A (the requester), not B.
    const friendsListRows = [
      { friend_id: CHARLIE, username: 'charlie', created_at: new Date() },
    ]
    // ALICE (requester) is friends with HOST_A.
    // BOB (list owner) is NOT friends with HOST_A.
    const friendPairs = [
      [BOB, CHARLIE],
      [ALICE, HOST_A],
    ]
    const db = makeFakeDb({ friendsListRows, friendPairs })
    const presences = {
      [CHARLIE]: { status: 'playing', tableId: 't1' },
    }
    const tables = {
      t1: { tableId: 't1', hostPlayerId: HOST_A, name: 'Alpha', visibility: 'friends-only' },
    }
    const redis = makeFakeRedis({ presences, tables })

    const enriched = await getFriends(db, BOB, { redis, requestingPlayerId: ALICE })
    const charlie = enriched.find((f) => f.playerId === CHARLIE)
    assert.ok(charlie)
    assert.equal(
      charlie.tableInfo.tableName,
      'Alpha',
      'host check must use requestingPlayerId (Alice), not the list-owner (Bob)',
    )
  })
})
