import pg from 'pg'

const { Pool } = pg

let pool = null

/**
 * Returns a shared pg Pool instance, creating one on first call.
 * Requires DATABASE_URL to be set in the environment.
 *
 * @returns {pg.Pool}
 */
export function getDb() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return pool
}

/**
 * Close the shared pool (used in tests and graceful shutdown).
 */
export async function closeDb() {
  if (pool) {
    await pool.end()
    pool = null
  }
}
