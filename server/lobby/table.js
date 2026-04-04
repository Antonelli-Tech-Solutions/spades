import { v4 as uuidv4 } from 'uuid'

const TABLE_TTL_SECONDS = 3600 // 1 hour of inactivity

/**
 * @typedef {Object} TableState
 * @property {string} tableId
 * @property {string} hostPlayerId
 * @property {string|null} name
 * @property {{ north: string|null, east: string|null, south: string|null, west: string|null }} seats
 * @property {'waiting'|'playing'} status
 * @property {string|null} gameId
 * @property {string} createdAt
 */

/**
 * Create a new table in Redis and return its ID.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {{ hostPlayerId: string, name?: string }} opts
 * @returns {Promise<TableState>}
 */
export async function createTable(redis, { hostPlayerId, name = null }) {
  const tableId = uuidv4()
  const table = {
    tableId,
    hostPlayerId,
    name,
    seats: { north: null, east: null, south: null, west: null },
    status: 'waiting',
    gameId: null,
    createdAt: new Date().toISOString(),
  }

  const key = `table:${tableId}`
  await redis.set(key, JSON.stringify(table), { EX: TABLE_TTL_SECONDS })

  // Add to the lobby index
  await redis.hSet('lobby:tables', tableId, JSON.stringify({ tableId, hostPlayerId, name, status: 'waiting' }))

  console.log('Table created:', { tableId, hostPlayerId, name })
  return table
}

/**
 * Retrieve a table from Redis.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @returns {Promise<TableState|null>}
 */
export async function getTable(redis, tableId) {
  const raw = await redis.get(`table:${tableId}`)
  return raw ? JSON.parse(raw) : null
}

/**
 * Persist an updated table state to Redis and reset its TTL.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {TableState} table
 */
export async function saveTable(redis, table) {
  const key = `table:${table.tableId}`
  await redis.set(key, JSON.stringify(table), { EX: TABLE_TTL_SECONDS })
}

/**
 * Seat a player at an empty seat.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} playerId
 * @param {'north'|'east'|'south'|'west'} seat
 * @returns {Promise<TableState>}
 * @throws {Error} If the table is not found, game already started, seat is taken, or player already seated
 */
export async function sitAtTable(redis, tableId, playerId, seat) {
  const validSeats = ['north', 'east', 'south', 'west']
  if (!validSeats.includes(seat)) {
    throw Object.assign(new Error(`Invalid seat: ${seat}`), { code: 'INVALID_SEAT' })
  }

  const table = await getTable(redis, tableId)
  if (!table) {
    throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
  }
  if (table.status === 'playing') {
    throw Object.assign(new Error('Game already in progress'), { code: 'GAME_IN_PROGRESS' })
  }
  if (table.seats[seat] !== null) {
    throw Object.assign(new Error('Seat is already taken'), { code: 'SEAT_TAKEN' })
  }
  // Check player isn't already seated
  const alreadySeated = Object.values(table.seats).includes(playerId)
  if (alreadySeated) {
    throw Object.assign(new Error('Player is already seated at this table'), { code: 'ALREADY_SEATED' })
  }

  const updated = {
    ...table,
    seats: { ...table.seats, [seat]: playerId },
  }
  await saveTable(redis, updated)
  console.log('Player seated:', { tableId, playerId, seat })
  return updated
}

/**
 * Return true if all 4 seats are occupied.
 * @param {TableState} table
 * @returns {boolean}
 */
export function isTableFull(table) {
  return Object.values(table.seats).every((p) => p !== null)
}

/**
 * Add a bot player to an empty seat. The bot's player ID is "bot:<seat>".
 * Reuses sitAtTable's validation (seat must be empty, game must not have started).
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {'north'|'east'|'south'|'west'} seat
 * @returns {Promise<TableState>}
 */
export async function addBotToTable(redis, tableId, seat) {
  return sitAtTable(redis, tableId, `bot:${seat}`, seat)
}

/**
 * Mark the table as in-game and record the gameId.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} gameId
 * @returns {Promise<TableState>}
 */
export async function markTablePlaying(redis, tableId, gameId) {
  const table = await getTable(redis, tableId)
  if (!table) throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })

  const updated = { ...table, status: 'playing', gameId }
  await saveTable(redis, updated)

  // Update lobby index
  await redis.hSet('lobby:tables', tableId, JSON.stringify({
    tableId,
    hostPlayerId: table.hostPlayerId,
    status: 'playing',
  }))

  return updated
}

/**
 * Retrieve the current game state for a table from Redis.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @returns {Promise<object|null>}
 */
export async function getGameState(redis, tableId) {
  const raw = await redis.get(`game:${tableId}`)
  return raw ? JSON.parse(raw) : null
}

/**
 * Persist game state to Redis.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {object} gameState
 */
export async function saveGameState(redis, tableId, gameState) {
  await redis.set(`game:${tableId}`, JSON.stringify(gameState), { EX: TABLE_TTL_SECONDS })
}

/**
 * Remove a player from any waiting table they are currently seated at.
 * Only affects tables with status 'waiting' — in-progress games require
 * separate disconnect handling.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} playerId
 */
export async function removePlayerFromTables(redis, playerId) {
  const raw = await redis.hGetAll('lobby:tables')
  for (const json of Object.values(raw)) {
    const entry = JSON.parse(json)
    if (entry.status !== 'waiting') continue
    const table = await getTable(redis, entry.tableId)
    if (!table || table.status !== 'waiting') continue
    const seatEntry = Object.entries(table.seats).find(([, id]) => id === playerId)
    if (!seatEntry) continue
    const [seat] = seatEntry
    const updated = { ...table, seats: { ...table.seats, [seat]: null } }
    await saveTable(redis, updated)
    console.log('Player removed from table on logout:', { tableId: table.tableId, playerId, seat })
  }
}

/**
 * Remove the requesting player from a waiting table's seat.
 * Only allowed while the table is in 'waiting' status — in-progress games
 * require separate disconnect handling.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} playerId
 * @returns {Promise<TableState>}
 * @throws {Error} If the table is not found, game is in progress, or player is not seated
 */
export async function leaveTable(redis, tableId, playerId) {
  const table = await getTable(redis, tableId)
  if (!table) {
    throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
  }
  if (table.status === 'playing') {
    throw Object.assign(new Error('Cannot leave a game in progress'), { code: 'GAME_IN_PROGRESS' })
  }
  const seatEntry = Object.entries(table.seats).find(([, id]) => id === playerId)
  if (!seatEntry) {
    throw Object.assign(new Error('You are not seated at this table'), { code: 'NOT_SEATED' })
  }
  const [seat] = seatEntry
  const updated = { ...table, seats: { ...table.seats, [seat]: null } }
  await saveTable(redis, updated)
  console.log('Player left table:', { tableId, playerId, seat })
  return updated
}

/**
 * Remove a human player from an in-progress game by replacing them with a bot.
 * If the departing player is the host, reassigns host to the next seated human.
 * If no human players remain after substitution, the table is terminated.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} playerId
 * @returns {Promise<{ terminated: true, seat: string } | { table: TableState, seat: string, botId: string, wasPlaying: true }>}
 * @throws {Error} If the table is not found, game is not in progress, or player is not seated
 */
export async function leaveInProgressGame(redis, tableId, playerId) {
  const table = await getTable(redis, tableId)
  if (!table) {
    throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
  }
  if (table.status !== 'playing') {
    throw Object.assign(new Error('Game is not in progress'), { code: 'NOT_IN_PROGRESS' })
  }
  const seatEntry = Object.entries(table.seats).find(([, id]) => id === playerId)
  if (!seatEntry) {
    throw Object.assign(new Error('You are not seated at this table'), { code: 'NOT_SEATED' })
  }
  const [seat] = seatEntry
  const botId = `bot:${seat}`
  const updatedSeats = { ...table.seats, [seat]: botId }

  // If no humans remain after substitution, terminate the table
  const remainingHuman = Object.values(updatedSeats).find((id) => id && !id.startsWith('bot:'))
  if (!remainingHuman) {
    await terminateTable(redis, tableId)
    console.log('Table terminated — no human players remain:', { tableId, playerId, seat })
    return { terminated: true, seat }
  }

  // Reassign host to a remaining human if the departing player was the host
  const newHostId = table.hostPlayerId === playerId ? remainingHuman : table.hostPlayerId
  const updated = { ...table, seats: updatedSeats, hostPlayerId: newHostId }
  await saveTable(redis, updated)
  console.log('Player left in-progress game, replaced by bot:', { tableId, playerId, seat, botId })
  return { table: updated, seat, botId, wasPlaying: true }
}

/**
 * Terminate a table and its associated game state, removing all Redis keys.
 * Used by the host to forcibly end a game at any point (waiting or in progress).
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 */
export async function terminateTable(redis, tableId) {
  await redis.del(`table:${tableId}`)
  await redis.del(`game:${tableId}`)
  await redis.hDel('lobby:tables', tableId)
  console.log('Table terminated:', { tableId })
}

/**
 * Find the tableId of an active table where the given player is seated.
 * Returns null if the player is not seated at any active table, or if the
 * only matching table's game is already over.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} playerId
 * @returns {Promise<string|null>}
 */
export async function findTableForPlayer(redis, playerId) {
  const raw = await redis.hGetAll('lobby:tables')
  for (const json of Object.values(raw)) {
    const entry = JSON.parse(json)
    const table = await getTable(redis, entry.tableId)
    if (!table) continue
    const seated = Object.values(table.seats).includes(playerId)
    if (!seated) continue
    if (table.status === 'playing') {
      const gameState = await getGameState(redis, entry.tableId)
      if (gameState && gameState.phase === 'game_over') continue
    }
    return entry.tableId
  }
  return null
}

/**
 * List all open (waiting) tables from the lobby index.
 * Fetches full table state for each waiting entry to include seat info.
 *
 * @param {import('redis').RedisClientType} redis
 * @returns {Promise<Array<{ tableId: string, name: string|null, hostPlayerId: string, seats: object, seatsAvailable: number }>>}
 */
export async function listTables(redis) {
  const raw = await redis.hGetAll('lobby:tables')
  const result = []
  for (const json of Object.values(raw)) {
    const entry = JSON.parse(json)
    if (entry.status !== 'waiting') continue
    const table = await getTable(redis, entry.tableId)
    if (!table || table.status !== 'waiting') continue
    const seatsAvailable = Object.values(table.seats).filter((p) => p === null).length
    result.push({
      tableId: table.tableId,
      name: table.name,
      hostPlayerId: table.hostPlayerId,
      seats: table.seats,
      seatsAvailable,
    })
  }
  return result
}
