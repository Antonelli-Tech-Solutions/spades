import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '../../../server/middleware/rateLimiter.js'

/**
 * Creates a simple in-memory mock Redis client for unit testing.
 * Tracks incr counts and TTLs without any real expiry.
 */
function createMockRedis() {
  const store = {}
  const ttls = {}
  return {
    async incr(key) {
      store[key] = (store[key] ?? 0) + 1
      return store[key]
    },
    async expire(key, seconds) {
      ttls[key] = seconds
      return 1
    },
    async ttl(key) {
      return ttls[key] ?? -1
    },
  }
}

/**
 * Creates a mock Express request/response/next triple for testing middleware.
 */
function makeMockContext(ip = '127.0.0.1') {
  const ctx = {
    req: { ip },
    headers: {},
    statusCode: null,
    jsonBody: null,
    nextCalled: false,
  }
  ctx.res = {
    setHeader(name, value) {
      ctx.headers[name] = value
    },
    status(code) {
      ctx.statusCode = code
      return this
    },
    json(body) {
      ctx.jsonBody = body
    },
  }
  ctx.next = () => {
    ctx.nextCalled = true
  }
  return ctx
}

describe('createRateLimiter', () => {
  it('calls next() when request count is under the limit', async () => {
    const redis = createMockRedis()
    const limiter = createRateLimiter(redis, { maxRequests: 5, windowSeconds: 60, keyPrefix: 'test' })
    const ctx = makeMockContext()

    await limiter(ctx.req, ctx.res, ctx.next)

    assert.ok(ctx.nextCalled, 'next() should be called')
    assert.equal(ctx.statusCode, null, 'status should not be set')
  })

  it('sets X-RateLimit-Limit header to configured maxRequests', async () => {
    const redis = createMockRedis()
    const limiter = createRateLimiter(redis, { maxRequests: 10, windowSeconds: 60, keyPrefix: 'test' })
    const ctx = makeMockContext()

    await limiter(ctx.req, ctx.res, ctx.next)

    assert.equal(ctx.headers['X-RateLimit-Limit'], 10)
  })

  it('decrements X-RateLimit-Remaining with each request from the same IP', async () => {
    const redis = createMockRedis()
    const limiter = createRateLimiter(redis, { maxRequests: 5, windowSeconds: 60, keyPrefix: 'test' })
    const ip = '192.168.1.100'

    for (let i = 1; i <= 4; i++) {
      const ctx = makeMockContext(ip)
      await limiter(ctx.req, ctx.res, ctx.next)
      assert.equal(ctx.headers['X-RateLimit-Remaining'], 5 - i)
    }
  })

  it('clamps X-RateLimit-Remaining to 0 when limit is exceeded', async () => {
    const redis = createMockRedis()
    const limiter = createRateLimiter(redis, { maxRequests: 2, windowSeconds: 60, keyPrefix: 'test' })
    const ip = '192.168.1.101'

    // Use up all requests
    for (let i = 0; i < 2; i++) {
      await limiter({ ip }, makeMockContext(ip).res, () => {})
    }

    // Exceed limit
    const ctx = makeMockContext(ip)
    await limiter(ctx.req, ctx.res, ctx.next)

    assert.equal(ctx.headers['X-RateLimit-Remaining'], 0, 'remaining should not go negative')
  })

  it('sets X-RateLimit-Reset header as a numeric Unix timestamp', async () => {
    const redis = createMockRedis()
    const limiter = createRateLimiter(redis, { maxRequests: 5, windowSeconds: 300, keyPrefix: 'test' })
    const ctx = makeMockContext()
    const before = Math.floor(Date.now() / 1000)

    await limiter(ctx.req, ctx.res, ctx.next)

    const reset = ctx.headers['X-RateLimit-Reset']
    assert.ok(typeof reset === 'number', 'X-RateLimit-Reset should be a number')
    assert.ok(reset >= before, 'reset timestamp should be in the future or present')
  })

  it('returns 429 and does not call next() when limit is exceeded', async () => {
    const redis = createMockRedis()
    const limiter = createRateLimiter(redis, { maxRequests: 2, windowSeconds: 60, keyPrefix: 'test' })
    const ip = '10.0.0.1'

    // Exhaust limit
    await limiter({ ip }, makeMockContext(ip).res, () => {})
    await limiter({ ip }, makeMockContext(ip).res, () => {})

    // Third request should be blocked
    const ctx = makeMockContext(ip)
    await limiter(ctx.req, ctx.res, ctx.next)

    assert.ok(!ctx.nextCalled, 'next() should not be called when rate limited')
    assert.equal(ctx.statusCode, 429)
  })

  it('sets Retry-After header when returning 429', async () => {
    const redis = createMockRedis()
    const limiter = createRateLimiter(redis, { maxRequests: 1, windowSeconds: 60, keyPrefix: 'test' })
    const ip = '10.0.0.2'

    await limiter({ ip }, makeMockContext(ip).res, () => {})

    const ctx = makeMockContext(ip)
    await limiter(ctx.req, ctx.res, ctx.next)

    assert.ok(ctx.headers['Retry-After'] !== undefined, 'Retry-After should be set on 429')
  })

  it('includes an error message in 429 response body', async () => {
    const redis = createMockRedis()
    const limiter = createRateLimiter(redis, { maxRequests: 1, windowSeconds: 60, keyPrefix: 'test' })
    const ip = '10.0.0.3'

    await limiter({ ip }, makeMockContext(ip).res, () => {})

    const ctx = makeMockContext(ip)
    await limiter(ctx.req, ctx.res, ctx.next)

    assert.ok(ctx.jsonBody?.error, 'response body should have an error field')
  })

  it('tracks request counts independently per IP address', async () => {
    const redis = createMockRedis()
    const limiter = createRateLimiter(redis, { maxRequests: 1, windowSeconds: 60, keyPrefix: 'test' })

    // Exhaust limit for IP A
    await limiter({ ip: '1.2.3.4' }, makeMockContext('1.2.3.4').res, () => {})
    const blockedCtx = makeMockContext('1.2.3.4')
    await limiter(blockedCtx.req, blockedCtx.res, blockedCtx.next)
    assert.ok(!blockedCtx.nextCalled, 'IP A should be rate limited')

    // IP B should still work
    const ctx = makeMockContext('5.6.7.8')
    await limiter(ctx.req, ctx.res, ctx.next)
    assert.ok(ctx.nextCalled, 'different IP should not be rate limited')
  })

  it('calls expire() with windowSeconds on the first request', async () => {
    let expireArgs = null
    const redis = {
      incr: async () => 1,
      expire: async (key, seconds) => {
        expireArgs = { key, seconds }
        return 1
      },
      ttl: async () => 60,
    }
    const limiter = createRateLimiter(redis, { maxRequests: 5, windowSeconds: 60, keyPrefix: 'auth' })
    await limiter({ ip: '1.2.3.4' }, makeMockContext().res, () => {})

    assert.ok(expireArgs !== null, 'expire() should be called on first request')
    assert.equal(expireArgs.seconds, 60, 'expire() should use windowSeconds')
  })

  it('does not call expire() on subsequent requests', async () => {
    let expireCallCount = 0
    const redis = {
      incr: async () => 2, // count > 1 simulates a subsequent request
      expire: async () => {
        expireCallCount++
        return 1
      },
      ttl: async () => 30,
    }
    const limiter = createRateLimiter(redis, { maxRequests: 5, windowSeconds: 60, keyPrefix: 'auth' })
    await limiter({ ip: '1.2.3.4' }, makeMockContext().res, () => {})

    assert.equal(expireCallCount, 0, 'expire() should not be called on subsequent requests')
  })

  it('uses keyPrefix to namespace Redis keys', async () => {
    let capturedKey = null
    const redis = {
      incr: async (key) => {
        capturedKey = key
        return 1
      },
      expire: async () => 1,
      ttl: async () => 60,
    }
    const limiter = createRateLimiter(redis, { maxRequests: 5, windowSeconds: 60, keyPrefix: 'myprefix' })
    await limiter({ ip: '1.2.3.4' }, makeMockContext().res, () => {})

    assert.ok(capturedKey?.startsWith('ratelimit:myprefix:'), 'key should include the prefix')
  })

  it('falls back to req.socket.remoteAddress when req.ip is absent', async () => {
    let capturedKey = null
    const redis = {
      incr: async (key) => {
        capturedKey = key
        return 1
      },
      expire: async () => 1,
      ttl: async () => 60,
    }
    const limiter = createRateLimiter(redis, { maxRequests: 5, windowSeconds: 60, keyPrefix: 'auth' })
    await limiter({ socket: { remoteAddress: '10.20.30.40' } }, makeMockContext().res, () => {})

    assert.ok(capturedKey?.includes('10.20.30.40'), 'should use socket.remoteAddress as fallback IP')
  })
})
