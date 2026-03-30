/**
 * Creates a Redis-backed fixed-window rate limiter Express middleware.
 *
 * Each unique IP address gets its own counter per keyPrefix namespace.
 * The counter resets after windowSeconds. On the first request for a given
 * key the TTL is set; subsequent increments reuse the existing expiry so the
 * window is not extended on every hit.
 *
 * Response headers on every request:
 *   X-RateLimit-Limit     — configured maximum requests per window
 *   X-RateLimit-Remaining — requests still allowed in the current window
 *   X-RateLimit-Reset     — Unix timestamp when the window resets
 *
 * Additional header when the limit is exceeded (429):
 *   Retry-After           — seconds until the window resets
 *
 * @param {object} redisClient - Connected redis v4 client (supports incr/expire/ttl)
 * @param {object} opts
 * @param {number} opts.maxRequests   - Maximum requests allowed per window
 * @param {number} opts.windowSeconds - Window duration in seconds
 * @param {string} opts.keyPrefix     - Namespace prefix for Redis keys
 * @returns {import('express').RequestHandler}
 */
export function createRateLimiter(redisClient, { maxRequests, windowSeconds, keyPrefix }) {
  return async (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown'
    const key = `ratelimit:${keyPrefix}:${ip}`

    const count = await redisClient.incr(key)
    if (count === 1) {
      // First request in this window — set the expiry
      await redisClient.expire(key, windowSeconds)
    }

    const ttl = await redisClient.ttl(key)
    const resetTimestamp = Math.floor(Date.now() / 1000) + Math.max(0, ttl)
    const remaining = Math.max(0, maxRequests - count)

    res.setHeader('X-RateLimit-Limit', maxRequests)
    res.setHeader('X-RateLimit-Remaining', remaining)
    res.setHeader('X-RateLimit-Reset', resetTimestamp)

    if (count > maxRequests) {
      res.setHeader('Retry-After', Math.max(0, ttl))
      return res.status(429).json({ error: 'Too many requests, please try again later.' })
    }

    next()
  }
}
