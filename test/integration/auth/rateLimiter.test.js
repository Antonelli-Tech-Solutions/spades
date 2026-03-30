/**
 * Integration tests for rate limiting on authentication endpoints.
 * Requires a real PostgreSQL instance (DATABASE_URL) and Redis (REDIS_URL).
 * Tests are skipped when either is not set.
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createClient } from 'redis'
import { handler } from '../../../server/server.js'
import { getDb, closeDb } from '../../../server/db.js'

const skip =
  !process.env.DATABASE_URL
    ? 'DATABASE_URL not set'
    : !process.env.REDIS_URL
      ? 'REDIS_URL not set'
      : false

async function startTestServer(redis, rateLimitConfig) {
  const testMailer = async () => {}
  const app = express()
  app.use(express.json())
  handler(app, { mailer: testMailer, redis, rateLimitConfig })
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
  await db.query(`DELETE FROM players WHERE email LIKE '%@test.spades.invalid'`)
}

async function clearRateLimitKeys(redis) {
  const keys = await redis.keys('ratelimit:auth:*')
  if (keys.length > 0) await redis.del(keys)
}

describe('Auth endpoint rate limiting', { skip }, () => {
  let server
  let db
  let redis
  // Use a low limit so tests do not need to make many requests
  const TEST_LIMIT = 3

  before(async () => {
    db = getDb()
    await resetTestSchema(db)
    redis = createClient({ url: process.env.REDIS_URL })
    await redis.connect()
    server = await startTestServer(redis, { maxRequests: TEST_LIMIT, windowSeconds: 60 })
  })

  after(async () => {
    await server.close()
    await closeDb()
    await clearRateLimitKeys(redis)
    await redis.quit()
  })

  beforeEach(async () => {
    await clearRateLimitKeys(redis)
  })

  it('does not rate limit requests within the limit on GET /api/auth/verify-email', async () => {
    for (let i = 0; i < TEST_LIMIT; i++) {
      const res = await fetch(
        `${server.baseUrl}/api/auth/verify-email?token=00000000-0000-4000-8000-00000000000${i}`,
      )
      assert.notEqual(res.status, 429, `Request ${i + 1} should not be rate limited`)
    }
  })

  it('returns 429 after exceeding the limit on GET /api/auth/verify-email', async () => {
    for (let i = 0; i < TEST_LIMIT; i++) {
      await fetch(
        `${server.baseUrl}/api/auth/verify-email?token=00000000-0000-4000-8000-00000000000${i}`,
      )
    }

    const res = await fetch(
      `${server.baseUrl}/api/auth/verify-email?token=00000000-0000-4000-8000-000000000099`,
    )
    assert.equal(res.status, 429)
  })

  it('returns 429 after exceeding the limit on POST /api/auth/register', async () => {
    for (let i = 0; i < TEST_LIMIT; i++) {
      await fetch(`${server.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: `ratelimit_reg_${i}@test.spades.invalid`,
          username: `ratelimit_reg_${i}`,
          password: 'password123',
        }),
      })
    }

    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'ratelimit_reg_blocked@test.spades.invalid',
        username: 'ratelimit_reg_blocked',
        password: 'password123',
      }),
    })
    assert.equal(res.status, 429)
  })

  it('includes X-RateLimit-Limit, X-RateLimit-Remaining, and X-RateLimit-Reset headers', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/auth/verify-email?token=00000000-0000-4000-8000-000000000000`,
    )

    assert.ok(
      res.headers.get('x-ratelimit-limit'),
      'X-RateLimit-Limit header should be present',
    )
    assert.ok(
      res.headers.get('x-ratelimit-remaining') !== null,
      'X-RateLimit-Remaining header should be present',
    )
    assert.ok(
      res.headers.get('x-ratelimit-reset'),
      'X-RateLimit-Reset header should be present',
    )
  })

  it('X-RateLimit-Limit matches the configured max', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/auth/verify-email?token=00000000-0000-4000-8000-000000000000`,
    )
    assert.equal(
      Number(res.headers.get('x-ratelimit-limit')),
      TEST_LIMIT,
    )
  })

  it('includes Retry-After header in 429 response', async () => {
    for (let i = 0; i < TEST_LIMIT; i++) {
      await fetch(
        `${server.baseUrl}/api/auth/verify-email?token=00000000-0000-4000-8000-00000000000${i}`,
      )
    }

    const res = await fetch(
      `${server.baseUrl}/api/auth/verify-email?token=00000000-0000-4000-8000-000000000099`,
    )
    assert.equal(res.status, 429)
    assert.ok(res.headers.get('retry-after'), 'Retry-After header should be set on 429 response')
  })

  it('429 response body contains an error field', async () => {
    for (let i = 0; i < TEST_LIMIT; i++) {
      await fetch(
        `${server.baseUrl}/api/auth/verify-email?token=00000000-0000-4000-8000-00000000000${i}`,
      )
    }

    const res = await fetch(
      `${server.baseUrl}/api/auth/verify-email?token=00000000-0000-4000-8000-000000000099`,
    )
    const body = await res.json()
    assert.ok(body.error, '429 response body should include an error field')
  })

  it('rate limit is shared across auth endpoints for the same IP', async () => {
    // Exhaust limit via verify-email
    for (let i = 0; i < TEST_LIMIT; i++) {
      await fetch(
        `${server.baseUrl}/api/auth/verify-email?token=00000000-0000-4000-8000-00000000000${i}`,
      )
    }

    // register should also be rate limited now
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'shared_limit@test.spades.invalid',
        username: 'shared_limit_user',
        password: 'password123',
      }),
    })
    assert.equal(res.status, 429, 'shared rate limit should apply across all auth endpoints')
  })
})
