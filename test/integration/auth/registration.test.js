/**
 * Integration tests for the registration and email-verification endpoints.
 * Requires a real PostgreSQL instance via DATABASE_URL.
 * Tests are skipped when DATABASE_URL is not set.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { handler } from '../../../server/server.js'
import { getDb, closeDb } from '../../../server/db.js'

const skip = !process.env.DATABASE_URL ? 'DATABASE_URL not set' : false

/**
 * Start an ephemeral Express server on a random port and return
 * { baseUrl, close } so tests can make real HTTP calls via fetch.
 */
async function startTestServer() {
  const sentEmails = []
  const testMailer = async (email, token) => sentEmails.push({ email, token })

  const app = express()
  app.use(express.json())
  handler(app, { mailer: testMailer })

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        sentEmails,
        close: () => new Promise((res) => server.close(res)),
      })
    })
  })
}

/** Ensure the schema exists and clear out test data before each run. */
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
  await db.query(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token UUID PRIMARY KEY,
      player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  // Remove any leftover test data (emails using the sentinel domain)
  await db.query(`DELETE FROM players WHERE email LIKE '%@test.spades.invalid'`)
}

describe('POST /api/auth/register', { skip }, () => {
  let server
  let db

  before(async () => {
    db = getDb()
    await resetTestSchema(db)
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    await closeDb()
  })

  it('returns 201 and a playerId on valid registration', async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@test.spades.invalid',
        username: 'alice_test',
        password: 'password123',
      }),
    })
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.ok(body.playerId, 'response should include playerId')
    assert.ok(body.message, 'response should include a message')
  })

  it('sends a verification email on registration', async () => {
    server.sentEmails.length = 0
    await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'bob@test.spades.invalid',
        username: 'bob_test',
        password: 'password123',
      }),
    })
    assert.equal(server.sentEmails.length, 1)
    assert.equal(server.sentEmails[0].email, 'bob@test.spades.invalid')
    assert.ok(server.sentEmails[0].token, 'email should carry a verification token')
  })

  it('stores account as unverified after registration', async () => {
    await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'carol@test.spades.invalid',
        username: 'carol_test',
        password: 'password123',
      }),
    })
    const result = await db.query(
      `SELECT is_verified FROM players WHERE email = $1`,
      ['carol@test.spades.invalid'],
    )
    assert.equal(result.rows[0].is_verified, false)
  })

  it('returns 400 when email is missing', async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'dave_test', password: 'password123' }),
    })
    assert.equal(res.status, 400)
  })

  it('returns 400 when password is too short', async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'dave@test.spades.invalid',
        username: 'dave_test',
        password: 'short',
      }),
    })
    assert.equal(res.status, 400)
  })

  it('returns 409 when email is already registered', async () => {
    const payload = {
      email: 'dup@test.spades.invalid',
      username: 'dup_test',
      password: 'password123',
    }
    await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, username: 'dup_test_2' }),
    })
    assert.equal(res.status, 409)
  })

  it('returns 409 when username is already taken', async () => {
    await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'unique1@test.spades.invalid',
        username: 'same_username',
        password: 'password123',
      }),
    })
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'unique2@test.spades.invalid',
        username: 'same_username',
        password: 'password123',
      }),
    })
    assert.equal(res.status, 409)
  })
})

describe('GET /api/auth/verify-email', { skip }, () => {
  let server
  let db

  before(async () => {
    db = getDb()
    await resetTestSchema(db)
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
    await closeDb()
  })

  it('redirects to /#/verify-email-success and marks account verified with a valid token', async () => {
    // Register a player to get a real token
    server.sentEmails.length = 0
    await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'verify_ok@test.spades.invalid',
        username: 'verify_ok',
        password: 'password123',
      }),
    })
    const { token } = server.sentEmails[0]

    const res = await fetch(`${server.baseUrl}/api/auth/verify-email?token=${token}`, { redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.ok(res.headers.get('location').includes('/verify-email-success'))

    const result = await db.query(
      `SELECT is_verified FROM players WHERE email = $1`,
      ['verify_ok@test.spades.invalid'],
    )
    assert.equal(result.rows[0].is_verified, true)
  })

  it('redirects to /#/verify-email-error for an invalid token', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/auth/verify-email?token=00000000-0000-4000-8000-000000000000`,
      { redirect: 'manual' },
    )
    assert.equal(res.status, 302)
    assert.ok(res.headers.get('location').includes('/verify-email-error'))
  })

  it('redirects to /#/verify-email-error when no token is provided', async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/verify-email`, { redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.ok(res.headers.get('location').includes('/verify-email-error'))
  })

  it('redirects to /#/verify-email-error when the same token is used twice (single use)', async () => {
    server.sentEmails.length = 0
    await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'singleuse@test.spades.invalid',
        username: 'singleuse_test',
        password: 'password123',
      }),
    })
    const { token } = server.sentEmails[0]

    await fetch(`${server.baseUrl}/api/auth/verify-email?token=${token}`, { redirect: 'manual' })
    const res = await fetch(`${server.baseUrl}/api/auth/verify-email?token=${token}`, { redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.ok(res.headers.get('location').includes('/verify-email-error'))
  })
})
