import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '../../../server/middleware/rateLimiter.js'

/**
 * Minimal mock Redis client for unit tests.
 * Stores key/value pairs and simulates INCR, EXPIRE, and TTL.
 */
function makeMockRedis() {
  const store = new Map()
  const ttls = new Map()

  return {
    async incr(key) {
      const current = store.get(key) ?? 0
      const next = current + 1
      store.set(key, next)
      return next
    },
    async expire(key, secs) {
      ttls.set(key, secs)
      return 1
    },
    async ttl(key) {
      return ttls.get(key) ?? -1
    },
    _store: store,
    _ttls: ttls,
  }
}

/**
 * Create a minimal mock Express req/res pair and a next() spy.
 */
function makeMockReqRes(ip = '127.0.0.1') {
  const headers = {}
  let statusCode = null
  let jsonBody = null
  let nextCalled = false

  const req = { ip }
  const res = {
    setHeader(name, value) {
      headers[name] = value
    },
    status(code) {
      statusCode = code
      return this
    },
    json(body) {
      jsonBody = body
      return this
    },
    _headers: headers,
    get statusCode() {
      return statusCode
    },
    get jsonBody() {
      return jsonBody
    },
  }
  const next = () => {
    nextCalled = true
  }

  return { req, res, next, get nextCalled() { return nextCalled } }
}

describe('createRateLimiter', () => {
  it('calls next() when under the limit', async () => {
    const redis = makeMockRedis()
    const limiter = createRateLimiter(redis, { keyPrefix: 'test', max: 5, windowSecs: 60 })

    const { req, res, next, get: _ } = makeMockReqRes()
    let called = false
    await limiter(req, res, () => { called = true })

    assert.ok(called, 'next() should be called when under limit')
    assert.equal(res.statusCode, null)
  })

  it('sets X-RateLimit-* headers on each request', async () => {
    const redis = makeMockRedis()
    const limiter = createRateLimiter(redis, { keyPrefix: 'hdr', max: 10, windowSecs: 60 })

    const { req, res } = makeMockReqRes()
    await limiter(req, res, () => {})

    assert.equal(res._headers['X-RateLimit-Limit'], '10')
    assert.ok(res._headers['X-RateLimit-Remaining'] !== undefined)
    assert.ok(res._headers['X-RateLimit-Reset'] !== undefined)
  })

  it('decrements X-RateLimit-Remaining with each request', async () => {
    const redis = makeMockRedis()
    const limiter = createRateLimiter(redis, { keyPrefix: 'rem', max: 3, windowSecs: 60 })
    const ip = '10.0.0.1'

    const results = []
    for (let i = 0; i < 3; i++) {
      const { req, res } = makeMockReqRes(ip)
      await limiter(req, res, () => {})
      results.push(Number(res._headers['X-RateLimit-Remaining']))
    }

    assert.deepEqual(results, [2, 1, 0])
  })

  it('returns 429 and sets Retry-After when the limit is exceeded', async () => {
    const redis = makeMockRedis()
    const limiter = createRateLimiter(redis, { keyPrefix: 'block', max: 2, windowSecs: 60 })
    const ip = '10.0.0.2'

    // Exhaust the limit
    for (let i = 0; i < 2; i++) {
      await limiter({ ip }, { setHeader: () => {}, status: () => ({ json: () => {} }), json: () => {} }, () => {})
    }

    // Next request should be blocked
    const { req, res } = makeMockReqRes(ip)
    let nextCalled = false
    await limiter(req, res, () => { nextCalled = true })

    assert.ok(!nextCalled, 'next() should not be called when limit is exceeded')
    assert.equal(res.statusCode, 429)
    assert.ok(res.jsonBody?.error, 'response should include an error message')
    assert.ok(res._headers['Retry-After'] !== undefined, 'Retry-After header should be set')
  })

  it('uses separate counters per IP', async () => {
    const redis = makeMockRedis()
    const limiter = createRateLimiter(redis, { keyPrefix: 'ip', max: 1, windowSecs: 60 })

    // IP A uses its one request
    const { req: reqA, res: resA } = makeMockReqRes('1.1.1.1')
    let aBlocked = false
    await limiter(reqA, resA, () => {})

    // IP A is now over limit
    const { req: reqA2, res: resA2 } = makeMockReqRes('1.1.1.1')
    await limiter(reqA2, resA2, () => {})
    assert.equal(resA2.statusCode, 429)

    // IP B should still pass through
    const { req: reqB, res: resB } = makeMockReqRes('2.2.2.2')
    let bPassed = false
    await limiter(reqB, resB, () => { bPassed = true })
    assert.ok(bPassed, 'IP B should not be rate limited by IP A exhausting their limit')
  })

  it('sets EXPIRE only on the first request (count === 1)', async () => {
    const redis = makeMockRedis()
    const limiter = createRateLimiter(redis, { keyPrefix: 'exp', max: 5, windowSecs: 60 })
    const ip = '3.3.3.3'

    await limiter({ ip }, { setHeader: () => {}, status: () => ({ json: () => {} }), json: () => {} }, () => {})
    const ttlAfterFirst = redis._ttls.get(`ratelimit:exp:${ip}`)

    await limiter({ ip }, { setHeader: () => {}, status: () => ({ json: () => {} }), json: () => {} }, () => {})
    const ttlAfterSecond = redis._ttls.get(`ratelimit:exp:${ip}`)

    assert.equal(ttlAfterFirst, 60)
    assert.equal(ttlAfterSecond, 60, 'EXPIRE should only be called once — TTL should not be reset')
    assert.equal(redis._ttls.size, 1, 'expire should only have been called once')
  })

  it('calls next() when no redis client is provided (graceful degradation)', async () => {
    const limiter = createRateLimiter(null, { keyPrefix: 'null', max: 5, windowSecs: 60 })

    let called = false
    await limiter({ ip: '4.4.4.4' }, {}, () => { called = true })
    assert.ok(called, 'next() should be called when redis is null')
  })

  it('uses AUTH_RATE_LIMIT_MAX and AUTH_RATE_LIMIT_WINDOW env vars as defaults', async () => {
    const original = { ...process.env }
    process.env.AUTH_RATE_LIMIT_MAX = '3'
    process.env.AUTH_RATE_LIMIT_WINDOW = '120'

    try {
      const redis = makeMockRedis()
      const limiter = createRateLimiter(redis, { keyPrefix: 'env' })
      const ip = '5.5.5.5'

      // Exhaust 3 requests
      for (let i = 0; i < 3; i++) {
        await limiter({ ip }, { setHeader: () => {}, status: () => ({ json: () => {} }), json: () => {} }, () => {})
      }

      // 4th request should be blocked
      const { req, res } = makeMockReqRes(ip)
      await limiter(req, res, () => {})
      assert.equal(res.statusCode, 429, '4th request should be blocked with max=3 from env')
    } finally {
      process.env.AUTH_RATE_LIMIT_MAX = original.AUTH_RATE_LIMIT_MAX ?? ''
      process.env.AUTH_RATE_LIMIT_WINDOW = original.AUTH_RATE_LIMIT_WINDOW ?? ''
      if (!original.AUTH_RATE_LIMIT_MAX) delete process.env.AUTH_RATE_LIMIT_MAX
      if (!original.AUTH_RATE_LIMIT_WINDOW) delete process.env.AUTH_RATE_LIMIT_WINDOW
    }
  })
})
