import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerUser, loginUser, resendVerification, forgotPassword, resetPassword, createTable, listTables, sitAtTable } from '../../../client/web/src/api.js'

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
