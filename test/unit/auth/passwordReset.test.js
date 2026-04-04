import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { forgotPassword, resetPassword } from '../../../server/auth/passwordReset.js'

describe('forgotPassword', { timeout: 2000 }, () => {
  it('succeeds silently when email is not found (prevents enumeration)', { timeout: 2000 }, async () => {
    const db = {
      query: async (sql) => {
        if (sql.includes('SELECT')) return { rows: [] }
        return { rows: [] }
      },
    }
    const emails = []
    await forgotPassword(db, 'ghost@example.com', async (email) => emails.push(email))
    assert.equal(emails.length, 0)
  })

  it('deletes old tokens, creates a new one, and sends email for existing player', { timeout: 2000 }, async () => {
    const queries = []
    const db = {
      query: async (sql, params) => {
        queries.push({ sql, params })
        if (sql.includes('SELECT id FROM players')) {
          return { rows: [{ id: 'player-1' }] }
        }
        return { rows: [] }
      },
    }
    const emails = []
    await forgotPassword(db, 'alice@example.com', async (email) => emails.push(email))

    const deleteQuery = queries.find((q) => q.sql.includes('DELETE'))
    assert.ok(deleteQuery, 'should delete old reset tokens')

    const insertQuery = queries.find((q) => q.sql.includes('INSERT INTO password_reset_tokens'))
    assert.ok(insertQuery, 'should insert a new reset token')

    assert.equal(emails.length, 1)
    assert.equal(emails[0], 'alice@example.com')
  })

  it('normalises email to lowercase before lookup', { timeout: 2000 }, async () => {
    const lookups = []
    const db = {
      query: async (sql, params) => {
        if (sql.includes('SELECT')) {
          lookups.push(params[0])
          return { rows: [] }
        }
        return { rows: [] }
      },
    }
    await forgotPassword(db, 'Alice@EXAMPLE.COM', { timeout: 2000 }, async () => {})
    assert.equal(lookups[0], 'alice@example.com')
  })
})

describe('resetPassword', { timeout: 2000 }, () => {
  it('throws VALIDATION_ERROR when token is missing', { timeout: 2000 }, async () => {
    const db = {}
    await assert.rejects(
      () => resetPassword(db, undefined, 'newpassword123'),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR')
        return true
      },
    )
  })

  it('throws VALIDATION_ERROR when new password is too short', { timeout: 2000 }, async () => {
    const db = {}
    await assert.rejects(
      () => resetPassword(db, 'some-token', 'short'),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR')
        return true
      },
    )
  })

  it('throws INVALID_TOKEN when token is not found', { timeout: 2000 }, async () => {
    const db = {
      query: async () => ({ rows: [] }),
    }
    await assert.rejects(
      () => resetPassword(db, 'nonexistent-token', 'newpassword123'),
      (err) => {
        assert.equal(err.code, 'INVALID_TOKEN')
        return true
      },
    )
  })

  it('throws EXPIRED_TOKEN when token is past its expiry', { timeout: 2000 }, async () => {
    const db = {
      query: async (sql) => {
        if (sql.includes('SELECT')) {
          return {
            rows: [{ player_id: 'player-1', expires_at: new Date(Date.now() - 1000) }],
          }
        }
        return { rows: [] }
      },
    }
    await assert.rejects(
      () => resetPassword(db, 'expired-token', 'newpassword123'),
      (err) => {
        assert.equal(err.code, 'EXPIRED_TOKEN')
        return true
      },
    )
  })

  it('updates the password hash and deletes the token on success', { timeout: 2000 }, async () => {
    const queries = []
    const db = {
      query: async (sql, params) => {
        queries.push({ sql, params })
        if (sql.includes('SELECT')) {
          return {
            rows: [{ player_id: 'player-1', expires_at: new Date(Date.now() + 3600 * 1000) }],
          }
        }
        return { rows: [] }
      },
    }
    const result = await resetPassword(db, 'valid-token', 'newpassword123')

    const updateQuery = queries.find((q) => q.sql.includes('UPDATE players'))
    assert.ok(updateQuery, 'should update the player password')

    const deleteQuery = queries.find((q) => q.sql.includes('DELETE FROM password_reset_tokens'))
    assert.ok(deleteQuery, 'should delete the used token')

    assert.equal(result.playerId, 'player-1')
  })
})
