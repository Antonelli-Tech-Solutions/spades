/**
 * Redis-backed fixed-window rate limiter middleware factory.
 *
 * @param {import('redis').RedisClientType} redisClient
 * @param {{ keyPrefix?: string, max?: number, windowSecs?: number }} [opts]
 * @returns {import('express').RequestHandler}
 */
export function createRateLimiter(redisClient, opts = {}) {
  const keyPrefix = opts.keyPrefix ?? 'rl'
  const max = opts.max ?? parseInt(process.env.AUTH_RATE_LIMIT_MAX ?? '10', 10)
  const windowSecs = opts.windowSecs ?? parseInt(process.env.AUTH_RATE_LIMIT_WINDOW ?? '900', 10)

  return async function rateLimiter(req, res, next) {
    if (!redisClient) {
      return next()
    }

    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown'
    const key = `ratelimit:${keyPrefix}:${ip}`

    try {
      const count = await redisClient.incr(key)

      if (count === 1) {
        await redisClient.expire(key, windowSecs)
      }

      const ttl = await redisClient.ttl(key)
      const resetAt = Math.floor(Date.now() / 1000) + (ttl > 0 ? ttl : windowSecs)
      const remaining = Math.max(0, max - count)

      res.setHeader('X-RateLimit-Limit', String(max))
      res.setHeader('X-RateLimit-Remaining', String(remaining))
      res.setHeader('X-RateLimit-Reset', String(resetAt))

      if (count > max) {
        res.setHeader('Retry-After', String(ttl > 0 ? ttl : windowSecs))
        return res.status(429).json({ error: 'Too many requests. Please try again later.' })
      }

      next()
    } catch (err) {
      console.error('Rate limiter error:', { key, error: err.message })
      next()
    }
  }
}
