import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  hashPassword,
  verifyPassword,
  generateVerificationToken,
  registerPlayer,
  verifyEmailToken,
  resendVerificationEmail,
} from '../../../server/auth/registration.js'

describe('hashPassword', { timeout: 2000 }, () => {
  it('produces a non-empty hash', { timeout: 2000 }, async () => {
    const hash = await hashPassword('hunter2')
    assert.ok(hash.length > 0)
  })

  it('produces different hashes for the same password (bcrypt salting)', { timeout: 2000 }, async () => {
    const hash1 = await hashPassword('hunter2')
    const hash2 = await hashPassword('hunter2')
    assert.notEqual(hash1, hash2)
  })
})

describe('verifyPassword', { timeout: 2000 }, () => {
  it('returns true for correct password', { timeout: 2000 }, async () => {
    const hash = await hashPassword('correcthorse')
    assert.ok(await verifyPassword('correcthorse', hash))
  })

  it('returns false for wrong password', { timeout: 2000 }, async () => {
    const hash = await hashPassword('correcthorse')
    assert.ok(!(await verifyPassword('wrongpassword', hash)))
  })
})

describe('generateVerificationToken', { timeout: 2000 }, () => {
  it('returns a UUID v4-formatted string', { timeout: 2000 }, () => {
    const token = generateVerificationToken()
    assert.match(
      token,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
  })

  it('returns unique tokens on each call', { timeout: 2000 }, () => {
    const tokens = new Set(Array.from({ length: 100 }, generateVerificationToken))
    assert.equal(tokens.size, 100)
  })
})

describe('registerPlayer — input validation', { timeout: 2000 }, () => {
  const noop = async () => {}

  it('throws VALIDATION_ERROR when email is missing', { timeout: 2000 }, async () => {
    const db = {}
    await assert.rejects(
      () => registerPlayer(db, { username: 'alice', password: 'password123' }, noop),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR')
        return true
      },
    )
  })

  it('throws VALIDATION_ERROR when username is missing', { timeout: 2000 }, async () => {
    const db = {}
    await assert.rejects(
      () => registerPlayer(db, { email: 'a@b.com', password: 'password123' }, noop),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR')
        return true
      },
    )
  })

  it('throws VALIDATION_ERROR when password is missing', { timeout: 2000 }, async () => {
    const db = {}
    await assert.rejects(
      () => registerPlayer(db, { email: 'a@b.com', username: 'alice' }, noop),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR')
        return true
      },
    )
  })

  it('throws VALIDATION_ERROR when password is too short', { timeout: 2000 }, async () => {
    const db = {}
    await assert.rejects(
      () => registerPlayer(db, { email: 'a@b.com', username: 'alice', password: 'short' }, noop),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR')
        return true
      },
    )
  })

  it('normalises email to lowercase before insert', { timeout: 2000 }, async () => {
    let capturedEmail
    const db = {
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO players')) {
          capturedEmail = params[0]
          return { rows: [{ id: 'fake-id' }] }
        }
        return { rows: [] }
      },
    }
    await registerPlayer(
      db,
      { email: 'Alice@Example.COM', username: 'alice', password: 'password123' },
      async (email) => { capturedEmail = email },
    )
    assert.equal(capturedEmail, 'alice@example.com')
  })
})

describe('resendVerificationEmail', { timeout: 2000 }, () => {
  it('succeeds silently when email is not found (prevents enumeration)', { timeout: 2000 }, async () => {
    const db = {
      query: async (sql) => {
        if (sql.includes('SELECT')) return { rows: [] }
        return { rows: [] }
      },
    }
    const emails = []
    await resendVerificationEmail(db, 'ghost@example.com', async (email) => emails.push(email))
    assert.equal(emails.length, 0)
  })

  it('succeeds silently when player is already verified (prevents enumeration)', { timeout: 2000 }, async () => {
    const db = {
      query: async (sql) => {
        if (sql.includes('SELECT')) return { rows: [{ id: 'player-1', is_verified: true }] }
        return { rows: [] }
      },
    }
    const emails = []
    await resendVerificationEmail(db, 'alice@example.com', async (email) => emails.push(email))
    assert.equal(emails.length, 0)
  })

  it('deletes old tokens and sends a new one for unverified player', { timeout: 2000 }, async () => {
    const queries = []
    const db = {
      query: async (sql, params) => {
        queries.push({ sql, params })
        if (sql.includes('SELECT')) return { rows: [{ id: 'player-1', is_verified: false }] }
        return { rows: [] }
      },
    }
    const emails = []
    await resendVerificationEmail(db, 'alice@example.com', async (email) => emails.push(email))

    const deleteQuery = queries.find((q) => q.sql.includes('DELETE'))
    assert.ok(deleteQuery, 'should delete old tokens')
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
    await resendVerificationEmail(db, 'Alice@EXAMPLE.COM', { timeout: 2000 }, async () => {})
    assert.equal(lookups[0], 'alice@example.com')
  })
})

describe('registerPlayer — DEV_AUTO_VERIFY', { timeout: 2000 }, () => {
  it('skips email and token when DEV_AUTO_VERIFY=true', { timeout: 2000 }, async () => {
    process.env.DEV_AUTO_VERIFY = 'true'
    const queries = []
    const emailsSent = []
    const db = {
      query: async (sql, params) => {
        queries.push({ sql, params })
        if (sql.includes('INSERT INTO players')) return { rows: [{ id: 'auto-id' }] }
        return { rows: [] }
      },
    }
    const result = await registerPlayer(
      db,
      { email: 'dev@example.com', username: 'devuser', password: 'password123' },
      async (email) => emailsSent.push(email),
    )
    delete process.env.DEV_AUTO_VERIFY

    assert.equal(result.playerId, 'auto-id')
    assert.equal(result.autoVerified, true, 'should return autoVerified: true')
    assert.equal(result.email, 'dev@example.com', 'should return normalised email')
    assert.equal(result.username, 'devuser', 'should return username')
    assert.equal(emailsSent.length, 0, 'should not send verification email')
    const tokenInsert = queries.find((q) => q.sql.includes('email_verification_tokens'))
    assert.ok(!tokenInsert, 'should not insert a verification token')
    const playerInsert = queries.find((q) => q.sql.includes('INSERT INTO players'))
    // is_verified param should be true
    assert.equal(playerInsert.params[3], true)
  })

  it('does NOT skip verification when NODE_ENV=production, even if DEV_AUTO_VERIFY=true', { timeout: 2000 }, async () => {
    process.env.DEV_AUTO_VERIFY = 'true'
    process.env.NODE_ENV = 'production'
    const emailsSent = []
    const db = {
      query: async (sql) => {
        if (sql.includes('INSERT INTO players')) return { rows: [{ id: 'prod-id' }] }
        return { rows: [] }
      },
    }
    await registerPlayer(
      db,
      { email: 'prod@example.com', username: 'produser', password: 'password123' },
      async (email) => emailsSent.push(email),
    )
    delete process.env.DEV_AUTO_VERIFY
    delete process.env.NODE_ENV

    assert.equal(emailsSent.length, 1, 'should still send verification email in production')
  })

  it('sends email normally when DEV_AUTO_VERIFY is not set', { timeout: 2000 }, async () => {
    delete process.env.DEV_AUTO_VERIFY
    const emailsSent = []
    const db = {
      query: async (sql) => {
        if (sql.includes('INSERT INTO players')) return { rows: [{ id: 'normal-id' }] }
        return { rows: [] }
      },
    }
    await registerPlayer(
      db,
      { email: 'user@example.com', username: 'normaluser', password: 'password123' },
      async (email) => emailsSent.push(email),
    )
    assert.equal(emailsSent.length, 1)
    assert.equal(emailsSent[0], 'user@example.com')
  })
})

describe('verifyEmailToken — input validation', { timeout: 2000 }, () => {
  it('throws VALIDATION_ERROR when token is missing', { timeout: 2000 }, async () => {
    const db = {}
    await assert.rejects(
      () => verifyEmailToken(db, undefined),
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
      () => verifyEmailToken(db, 'nonexistent-token'),
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
            rows: [{ player_id: 'some-id', expires_at: new Date(Date.now() - 1000) }],
          }
        }
        return { rows: [] }
      },
    }
    await assert.rejects(
      () => verifyEmailToken(db, 'expired-token'),
      (err) => {
        assert.equal(err.code, 'EXPIRED_TOKEN')
        return true
      },
    )
  })
})
