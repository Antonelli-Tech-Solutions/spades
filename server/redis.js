import { createClient } from 'redis'

let client = null

/**
 * Returns a connected Redis client, creating one on first call.
 * Requires REDIS_URL to be set in the environment.
 *
 * @returns {Promise<import('redis').RedisClientType>}
 */
export async function getRedis() {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL })
    client.on('error', (err) => console.error('Redis client error:', err))
    await client.connect()
  }
  return client
}

/**
 * Close the shared Redis client (used in tests and graceful shutdown).
 */
export async function closeRedis() {
  if (client) {
    await client.quit()
    client = null
  }
}
