import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerUser, loginUser, logoutUser, resendVerification, forgotPassword, resetPassword, createTable, listTables, sitAtTable, getGameState, placeBid, playCard, submitBlindNilExchange } from '../../../client/web/src/api.js'

/**
 * Build a minimal mock fetch that returns the given status and JSON body.
 */
function mockFetch(status, body) {
  return async (_url, _opts) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

describe('registerUser', () => {
  it('resolves with the response body on 201', async () => {
    const result = await registerUser(
      { email: 'a@b.com', username: 'alice', password: 'password123' },
      mockFetch(201, { playerId: 'uuid-123', message: 'Registration successful.' }),
    )
    assert.equal(result.playerId, 'uuid-123')
  })

  it('throws with status 409 on duplicate email/username', async () => {
    await assert.rejects(
      () =>
        registerUser(
          { email: 'a@b.com', username: 'alice', password: 'password123' },
          mockFetch(409, { error: 'Email already in use.' }),
        ),
      (err) => {
        assert.equal(err.status, 409)
        assert.match(err.message, /Email already in use/)
        return true
      },
    )
  })

  it('throws with status 400 on validation error', async () => {
    await assert.rejects(
      () =>
        registerUser(
          { email: 'a@b.com', username: 'alice', password: 'short' },
          mockFetch(400, { error: 'Password must be at least 8 characters.' }),
        ),
      (err) => {
        assert.equal(err.status, 400)
        return true
      },
    )
  })

  it('throws a generic message when response body has no error field', async () => {
    await assert.rejects(
      () =>
        registerUser(
          { email: 'a@b.com', username: 'alice', password: 'password123' },
          mockFetch(500, {}),
        ),
      (err) => {
        assert.ok(err.message)
        return true
      },
    )
  })
})

describe('resendVerification', () => {
  it('resolves on 200', async () => {
    const result = await resendVerification(
      { email: 'a@b.com' },
      mockFetch(200, { message: 'If this email is registered and unverified, a new link has been sent.' }),
    )
    assert.ok(result.message)
  })

  it('throws on network/server error', async () => {
    await assert.rejects(
      () => resendVerification({ email: 'a@b.com' }, mockFetch(500, { error: 'Internal server error' })),
      (err) => {
        assert.equal(err.status, 500)
        return true
      },
    )
  })
})

describe('forgotPassword', () => {
  it('resolves on 200', async () => {
    const result = await forgotPassword(
      { email: 'a@b.com' },
      mockFetch(200, { message: 'If that email is registered, a reset link has been sent.' }),
    )
    assert.ok(result.message)
  })

  it('throws on server error', async () => {
    await assert.rejects(
      () => forgotPassword({ email: 'a@b.com' }, mockFetch(500, { error: 'Internal server error' })),
      (err) => {
        assert.equal(err.status, 500)
        return true
      },
    )
  })
})

describe('resetPassword', () => {
  it('resolves with message on 200', async () => {
    const result = await resetPassword(
      { token: 'valid-token', newPassword: 'newpassword123' },
      mockFetch(200, { message: 'Password reset successfully. You may now sign in.' }),
    )
    assert.ok(result.message)
  })

  it('throws with status 400 on invalid or expired token', async () => {
    await assert.rejects(
      () =>
        resetPassword(
          { token: 'bad-token', newPassword: 'newpassword123' },
          mockFetch(400, { error: 'invalid or already used reset token' }),
        ),
      (err) => {
        assert.equal(err.status, 400)
        return true
      },
    )
  })
})

describe('logoutUser', () => {
  it('resolves with message on 200', async () => {
    const result = await logoutUser(
      { sessionId: 'sess-1' },
      mockFetch(200, { message: 'Logged out successfully.' }),
    )
    assert.ok(result.message)
  })

  it('throws on server error', async () => {
    await assert.rejects(
      () => logoutUser({ sessionId: 'sess-1' }, mockFetch(500, { error: 'Internal server error' })),
      (err) => {
        assert.equal(err.status, 500)
        return true
      },
    )
  })
})

describe('loginUser', () => {
  it('resolves with sessionId, playerId, and username on 200', async () => {
    const result = await loginUser(
      { email: 'a@b.com', password: 'password123' },
      mockFetch(200, { sessionId: 'sess-1', playerId: 'uuid-1', username: 'alice' }),
    )
    assert.equal(result.sessionId, 'sess-1')
    assert.equal(result.playerId, 'uuid-1')
    assert.equal(result.username, 'alice')
  })

  it('throws with status 401 on invalid credentials', async () => {
    await assert.rejects(
      () =>
        loginUser(
          { email: 'a@b.com', password: 'wrongpass' },
          mockFetch(401, { error: 'Invalid credentials.' }),
        ),
      (err) => {
        assert.equal(err.status, 401)
        return true
      },
    )
  })

  it('throws with status 403 on unverified email', async () => {
    await assert.rejects(
      () =>
        loginUser(
          { email: 'a@b.com', password: 'password123' },
          mockFetch(403, { error: 'Email not verified.' }),
        ),
      (err) => {
        assert.equal(err.status, 403)
        return true
      },
    )
  })

  it('throws with status 400 when fields are missing', async () => {
    await assert.rejects(
      () =>
        loginUser(
          { email: 'a@b.com', password: '' },
          mockFetch(400, { error: 'Password is required.' }),
        ),
      (err) => {
        assert.equal(err.status, 400)
        return true
      },
    )
  })
})

describe('createTable', () => {
  const auth = { sessionId: 'sess-1', playerId: 'player-1' }

  it('resolves with tableId and name on 201', async () => {
    const result = await createTable(
      { name: 'Friday Night', ...auth },
      mockFetch(201, { tableId: 'table-uuid', name: 'Friday Night' }),
    )
    assert.equal(result.tableId, 'table-uuid')
    assert.equal(result.name, 'Friday Night')
  })

  it('resolves with null name when no name provided', async () => {
    const result = await createTable(
      { ...auth },
      mockFetch(201, { tableId: 'table-uuid', name: null }),
    )
    assert.equal(result.tableId, 'table-uuid')
    assert.equal(result.name, null)
  })

  it('throws with status 401 when unauthenticated', async () => {
    await assert.rejects(
      () => createTable({ ...auth }, mockFetch(401, { error: 'Unauthorized.' })),
      (err) => {
        assert.equal(err.status, 401)
        return true
      },
    )
  })

  it('throws with status 400 when name is too long', async () => {
    await assert.rejects(
      () => createTable(
        { name: 'x'.repeat(51), ...auth },
        mockFetch(400, { error: 'Table name must be 50 characters or fewer.' }),
      ),
      (err) => {
        assert.equal(err.status, 400)
        assert.match(err.message, /50 characters/)
        return true
      },
    )
  })
})

describe('listTables', () => {
  const auth = { sessionId: 'sess-1', playerId: 'player-1' }

  it('resolves with tables array on 200', async () => {
    const tables = [
      { tableId: 'table-1', name: 'Friday Night', seats: { north: null, east: null, south: null, west: null }, seatsAvailable: 4 },
    ]
    const result = await listTables(auth, mockFetch(200, { tables }))
    assert.deepEqual(result.tables, tables)
  })

  it('resolves with empty array when no tables', async () => {
    const result = await listTables(auth, mockFetch(200, { tables: [] }))
    assert.deepEqual(result.tables, [])
  })

  it('throws with status 401 when unauthenticated', async () => {
    await assert.rejects(
      () => listTables(auth, mockFetch(401, { error: 'Unauthorized.' })),
      (err) => {
        assert.equal(err.status, 401)
        return true
      },
    )
  })
})

describe('sitAtTable', () => {
  const auth = { sessionId: 'sess-1', playerId: 'player-1' }

  it('resolves on 200 with tableId and seat', async () => {
    const result = await sitAtTable(
      { tableId: 'table-1', seat: 'north', ...auth },
      mockFetch(200, { tableId: 'table-1', seat: 'north' }),
    )
    assert.equal(result.tableId, 'table-1')
    assert.equal(result.seat, 'north')
  })

  it('throws with status 409 when seat is taken', async () => {
    await assert.rejects(
      () => sitAtTable(
        { tableId: 'table-1', seat: 'north', ...auth },
        mockFetch(409, { error: 'Seat is already taken' }),
      ),
      (err) => {
        assert.equal(err.status, 409)
        return true
      },
    )
  })

  it('throws with status 401 when unauthenticated', async () => {
    await assert.rejects(
      () => sitAtTable(
        { tableId: 'table-1', seat: 'north', ...auth },
        mockFetch(401, { error: 'Unauthorized.' }),
      ),
      (err) => {
        assert.equal(err.status, 401)
        return true
      },
    )
  })
})

describe('getGameState', () => {
  const auth = { tableId: 'table-1', sessionId: 'sess-1', playerId: 'player-1' }

  it('resolves with game state on 200', async () => {
    const gameState = { phase: 'bidding', myHand: [], scores: { ns: 0, ew: 0 }, bags: { ns: 0, ew: 0 } }
    const result = await getGameState(auth, mockFetch(200, gameState))
    assert.equal(result.phase, 'bidding')
    assert.deepEqual(result.myHand, [])
  })

  it('throws with status 401 when unauthenticated', async () => {
    await assert.rejects(
      () => getGameState(auth, mockFetch(401, { error: 'Unauthorized.' })),
      (err) => { assert.equal(err.status, 401); return true },
    )
  })

  it('throws with status 403 when not seated at table', async () => {
    await assert.rejects(
      () => getGameState(auth, mockFetch(403, { error: 'You are not seated at this table' })),
      (err) => { assert.equal(err.status, 403); return true },
    )
  })

  it('throws with status 404 when table not found', async () => {
    await assert.rejects(
      () => getGameState(auth, mockFetch(404, { error: 'Table not found' })),
      (err) => { assert.equal(err.status, 404); return true },
    )
  })
})

describe('placeBid', () => {
  const auth = { tableId: 'table-1', bid: 3, sessionId: 'sess-1', playerId: 'player-1' }

  it('resolves with updated state on 200', async () => {
    const state = { phase: 'bidding', bids: { north: null, east: 3, south: null, west: null }, currentBidderSeat: 'south' }
    const result = await placeBid(auth, mockFetch(200, state))
    assert.equal(result.bids.east, 3)
    assert.equal(result.currentBidderSeat, 'south')
  })

  it('throws with status 409 when not this player\'s turn', async () => {
    await assert.rejects(
      () => placeBid(auth, mockFetch(409, { error: 'Not your turn to bid' })),
      (err) => { assert.equal(err.status, 409); return true },
    )
  })

  it('throws with status 400 on invalid bid value', async () => {
    await assert.rejects(
      () => placeBid({ ...auth, bid: 14 }, mockFetch(400, { error: 'Invalid bid value: 14' })),
      (err) => { assert.equal(err.status, 400); return true },
    )
  })

  it('throws with status 400 when not eligible for blind nil', async () => {
    await assert.rejects(
      () => placeBid({ ...auth, bid: 'blind_nil' }, mockFetch(400, { error: 'Not eligible for Blind Nil' })),
      (err) => {
        assert.equal(err.status, 400)
        assert.match(err.message, /Blind Nil/)
        return true
      },
    )
  })

  it('throws with status 401 when unauthenticated', async () => {
    await assert.rejects(
      () => placeBid(auth, mockFetch(401, { error: 'Unauthorized.' })),
      (err) => { assert.equal(err.status, 401); return true },
    )
  })
})

describe('playCard', () => {
  const card = { suit: 'spades', rank: 'A' }
  const auth = { tableId: 'table-1', card, sessionId: 'sess-1', playerId: 'player-1' }

  it('resolves with updated state on 200', async () => {
    const state = { phase: 'playing', currentTrick: [{ seat: 'east', card }] }
    const result = await playCard(auth, mockFetch(200, state))
    assert.equal(result.phase, 'playing')
    assert.equal(result.currentTrick.length, 1)
  })

  it('throws with status 409 when not this player\'s turn', async () => {
    await assert.rejects(
      () => playCard(auth, mockFetch(409, { error: 'Not your turn to play' })),
      (err) => { assert.equal(err.status, 409); return true },
    )
  })

  it('throws with status 400 on illegal play', async () => {
    await assert.rejects(
      () => playCard(auth, mockFetch(400, { error: 'Illegal play' })),
      (err) => { assert.equal(err.status, 400); return true },
    )
  })

  it('throws with status 400 when card not in hand', async () => {
    await assert.rejects(
      () => playCard(auth, mockFetch(400, { error: 'Card not in hand' })),
      (err) => { assert.equal(err.status, 400); return true },
    )
  })

  it('throws with status 401 when unauthenticated', async () => {
    await assert.rejects(
      () => playCard(auth, mockFetch(401, { error: 'Unauthorized.' })),
      (err) => { assert.equal(err.status, 401); return true },
    )
  })
})

describe('submitBlindNilExchange', () => {
  const cards = [{ suit: 'spades', rank: 'A' }, { suit: 'hearts', rank: 'K' }]
  const auth = { tableId: 'table-1', cards, sessionId: 'sess-1', playerId: 'player-1' }

  it('resolves with updated state on 200', async () => {
    const state = { phase: 'playing', currentPlayerSeat: 'east' }
    const result = await submitBlindNilExchange(auth, mockFetch(200, state))
    assert.equal(result.phase, 'playing')
  })

  it('throws with status 400 on invalid exchange (wrong number of cards)', async () => {
    await assert.rejects(
      () => submitBlindNilExchange({ ...auth, cards: [cards[0]] }, mockFetch(400, { error: 'Must submit exactly 2 cards' })),
      (err) => {
        assert.equal(err.status, 400)
        assert.match(err.message, /2 cards/)
        return true
      },
    )
  })

  it('throws with status 400 when wrong player tries to exchange', async () => {
    await assert.rejects(
      () => submitBlindNilExchange(auth, mockFetch(400, { error: 'Blind Nil player must send cards first' })),
      (err) => { assert.equal(err.status, 400); return true },
    )
  })

  it('throws with status 401 when unauthenticated', async () => {
    await assert.rejects(
      () => submitBlindNilExchange(auth, mockFetch(401, { error: 'Unauthorized.' })),
      (err) => { assert.equal(err.status, 401); return true },
    )
  })
})
