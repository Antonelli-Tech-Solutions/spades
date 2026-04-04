/**
 * Integration tests for rate limiting on auth endpoints.
 * Requires a real Redis instance (REDIS_URL).
 * Tests are skipped when REDIS_URL is not set.
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { handler } from '../../../server/server.js'
import { getRedis, closeRedis } from '../../../server/redis.js'

const skip = !process.env.REDIS_URL ? 'REDIS_URL not set' : false

async function startTestServer(redis) {
  const app = express()
  app.use(express.json())
  // Use a very low limit so tests don't need many requests
  handler(app, { redis, rateLimitConfig: { max: 3, windowSecs: 60 } })

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

async function flushRateLimitKeys(redis) {
  // Remove only test rate limit keys to avoid affecting other data
  const keys = await redis.keys('ratelimit:auth:*')
  if (keys.length > 0) {
    await redis.del(keys)
  }
}

describe('Auth endpoint rate limiting', { skip }, () => {
  let server
  let redis

  before(async () => {
    redis = await getRedis()
    await flushRateLimitKeys(redis)
    server = await startTestServer(redis)
  })

  beforeEach(async () => {
    await flushRateLimitKeys(redis)
  })

  after(async () => {
    await server.close()
    await closeRedis()
  })

  it('sets X-RateLimit-* headers on POST /api/auth/register', { timeout: 10000 }, async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@test.invalid', username: 'a_test', password: 'password123' }),
    })
    assert.ok(res.headers.get('x-ratelimit-limit'), 'X-RateLimit-Limit should be set')
    assert.ok(res.headers.get('x-ratelimit-remaining'), 'X-RateLimit-Remaining should be set')
    assert.ok(res.headers.get('x-ratelimit-reset'), 'X-RateLimit-Reset should be set')
  })

  it('returns 429 after limit is exceeded on POST /api/auth/register', { timeout: 10000 }, async () => {
    for (let i = 0; i < 3; i++) {
      await fetch(`${server.baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `reg${i}@test.invalid`, username: `reg_u${i}`, password: 'password123' }),
      })
    }

    const blocked = await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'extra@test.invalid', username: 'extra_u', password: 'password123' }),
    })
    assert.equal(blocked.status, 429)
    assert.ok(blocked.headers.get('retry-after'), 'Retry-After header should be set on 429')
    const body = await blocked.json()
    assert.ok(body.error, 'error message should be in response body')
  })

  it('returns 429 after limit is exceeded on POST /api/auth/login', { timeout: 10000 }, async () => {
    for (let i = 0; i < 3; i++) {
      await fetch(`${server.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `login${i}@test.invalid`, password: 'password123' }),
      })
    }

    const blocked = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'extra@test.invalid', password: 'password123' }),
    })
    assert.equal(blocked.status, 429)
    assert.ok(blocked.headers.get('retry-after'), 'Retry-After header should be set on 429')
  })

  it('returns 429 after limit is exceeded on GET /api/auth/verify-email', { timeout: 10000 }, async () => {
    for (let i = 0; i < 3; i++) {
      await fetch(`${server.baseUrl}/api/auth/verify-email?token=some-token-${i}`)
    }

    const blocked = await fetch(`${server.baseUrl}/api/auth/verify-email?token=extra-token`)
    assert.equal(blocked.status, 429)
    assert.ok(blocked.headers.get('retry-after'), 'Retry-After header should be set on 429')
  })

  it('shares a single counter across all auth endpoints (same IP)', { timeout: 10000 }, async () => {
    // Mix register, login, and verify-email — all share the same rate limit key per IP
    await fetch(`${server.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@test.invalid', username: 'x_test', password: 'password123' }),
    })
    await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@test.invalid', password: 'password123' }),
    })
    await fetch(`${server.baseUrl}/api/auth/verify-email?token=abc`)

    // 4th request across any endpoint should be blocked
    const blocked = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@test.invalid', password: 'password123' }),
    })
    assert.equal(blocked.status, 429)
  })
})
