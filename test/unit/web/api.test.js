import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerUser, loginUser } from '../../../client/web/src/api.js'

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
