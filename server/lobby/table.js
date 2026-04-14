import { v4 as uuidv4 } from 'uuid'

const TABLE_TTL_SECONDS = 3600 // 1 hour of inactivity
const MAX_OBSERVERS = 20

/**
 * @typedef {Object} TableState
 * @property {string} tableId
 * @property {string} hostPlayerId
 * @property {string|null} name
 * @property {{ north: string|null, east: string|null, south: string|null, west: string|null }} seats
 * @property {string[]} observers
 * @property {'waiting'|'playing'} status
 * @property {string|null} gameId
 * @property {string} createdAt
 * @property {'public'|'friends-only'|'private'} visibility
 * @property {'open'|'friends-only'|'invite-only'} joinPolicy
 * @property {boolean} spectating
 */

export const VALID_VISIBILITIES = ['public', 'friends-only', 'private']
export const VALID_JOIN_POLICIES = ['open', 'friends-only', 'invite-only']

export const JOIN_POLICIES_BY_VISIBILITY = {
  'public': ['open', 'friends-only', 'invite-only'],
  'friends-only': ['friends-only', 'invite-only'],
  'private': ['invite-only'],
}

const DEFAULT_JOIN_POLICY = {
  'public': 'open',
  'friends-only': 'friends-only',
  'private': 'invite-only',
}

export function resolveJoinPolicy(visibility, joinPolicy) {
  const allowed = JOIN_POLICIES_BY_VISIBILITY[visibility]
  if (!allowed) return 'open'
  if (joinPolicy && allowed.includes(joinPolicy)) return joinPolicy
  return DEFAULT_JOIN_POLICY[visibility]
}

export function validateJoinPolicy(visibility, joinPolicy) {
  if (!joinPolicy) return null
  const allowed = JOIN_POLICIES_BY_VISIBILITY[visibility]
  if (!allowed) return null
  if (!allowed.includes(joinPolicy)) {
    return `Join policy '${joinPolicy}' is not allowed for '${visibility}' visibility. Allowed: ${allowed.join(', ')}`
  }
  return null
}

/**
 * Create a new table in Redis and return its ID.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {{ hostPlayerId: string, name?: string, visibility?: string, joinPolicy?: string, spectating?: boolean }} opts
 * @returns {Promise<TableState>}
 */
export async function createTable(redis, { hostPlayerId, name = null, visibility = 'public', joinPolicy, spectating = true }) {
  const tableId = uuidv4()
  const resolvedJoinPolicy = resolveJoinPolicy(visibility, joinPolicy)
  const table = {
    tableId,
    hostPlayerId,
    name,
    seats: { north: null, east: null, south: null, west: null },
    observers: [],
    status: 'waiting',
    gameId: null,
    createdAt: new Date().toISOString(),
    visibility,
    joinPolicy: resolvedJoinPolicy,
    spectating: Boolean(spectating),
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

  const spectatorOnly = await isSpectatorOnly(redis, tableId, playerId)
  if (spectatorOnly) {
    throw Object.assign(new Error('Spectators cannot sit at the table'), { code: 'FORBIDDEN' })
  }

  if (table.status === 'playing') {
    throw Object.assign(new Error('Game already in progress'), { code: 'GAME_IN_PROGRESS' })
  }
  // Check idempotent same-seat before checking seat occupancy
  const currentSeat = Object.entries(table.seats).find(([, id]) => id === playerId)?.[0]
  if (currentSeat === seat) {
    // Already at this exact seat — no-op, return current state
    return table
  }
  if (currentSeat) {
    throw Object.assign(new Error('Player is already seated at this table'), { code: 'ALREADY_SEATED' })
  }
  if (table.seats[seat] !== null) {
    throw Object.assign(new Error('Seat is already taken'), { code: 'SEAT_TAKEN' })
  }

  const updatedObservers = (table.observers || []).filter((id) => id !== playerId)
  const updated = {
    ...table,
    seats: { ...table.seats, [seat]: playerId },
    observers: updatedObservers,
  }
  await saveTable(redis, updated)
  console.log('Player seated:', { tableId, playerId, seat })
  return updated
}

/**
 * Join a table as an observer (not seated). Idempotent — returns current state
 * if the player is already seated or already observing.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} playerId
 * @returns {Promise<TableState>}
 * @throws {Error} If the table is not found
 */
export async function joinTable(redis, tableId, playerId) {
  const table = await getTable(redis, tableId)
  if (!table) {
    throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
  }
  const seated = Object.values(table.seats).includes(playerId)
  if (seated) return table
  const observers = table.observers || []
  if (observers.includes(playerId)) return table
  if (observers.length >= MAX_OBSERVERS) {
    throw Object.assign(new Error('Table has reached the maximum number of observers'), { code: 'OBSERVERS_FULL' })
  }
  const updated = { ...table, observers: [...observers, playerId] }
  await saveTable(redis, updated)
  console.log('Player joined table as observer:', { tableId, playerId })
  return updated
}

/**
 * Stand up from a seat, becoming an observer. Only allowed while waiting.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} playerId
 * @returns {Promise<{ table: TableState, seat: string }>}
 * @throws {Error} If the table is not found, game in progress, or player not seated
 */
export async function standFromSeat(redis, tableId, playerId) {
  const table = await getTable(redis, tableId)
  if (!table) {
    throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
  }
  if (table.status === 'playing') {
    throw Object.assign(new Error('Cannot stand once the game has started'), { code: 'GAME_IN_PROGRESS' })
  }
  const seatEntry = Object.entries(table.seats).find(([, id]) => id === playerId)
  if (!seatEntry) {
    throw Object.assign(new Error('You are not seated at this table'), { code: 'NOT_SEATED' })
  }
  const [seat] = seatEntry
  const updatedSeats = { ...table.seats, [seat]: null }
  const observers = [...(table.observers || []), playerId]

  let newHostId = table.hostPlayerId
  let hostChanged = false
  if (table.hostPlayerId === playerId) {
    // Pick next seated human in fixed seat order (north → east → south → west)
    const seatOrder = ['north', 'east', 'south', 'west']
    const remainingSeatedHuman = seatOrder
      .map((s) => updatedSeats[s])
      .find((id) => id && !id.startsWith('bot:'))
    if (!remainingSeatedHuman) {
      throw Object.assign(new Error('Host cannot stand when no other human is seated'), { code: 'HOST_MUST_SIT' })
    }
    newHostId = remainingSeatedHuman
    hostChanged = true
  }

  const updated = { ...table, seats: updatedSeats, hostPlayerId: newHostId, observers }
  await saveTable(redis, updated)
  console.log('Player stood from seat:', { tableId, playerId, seat })
  return { table: updated, seat, hostChanged }
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
  const updatedTables = []
  const terminatedTables = []
  for (const json of Object.values(raw)) {
    const entry = JSON.parse(json)
    if (entry.status !== 'waiting') continue
    const table = await getTable(redis, entry.tableId)
    if (!table || table.status !== 'waiting') continue
    const seatEntry = Object.entries(table.seats).find(([, id]) => id === playerId)
    const isObserver = (table.observers || []).includes(playerId)
    if (!seatEntry && !isObserver) continue

    if (!seatEntry && isObserver) {
      const updatedObservers = (table.observers || []).filter((id) => id !== playerId)
      const updated = { ...table, observers: updatedObservers }
      await saveTable(redis, updated)
      updatedTables.push(updated)
      console.log('Observer removed from table on logout:', { tableId: table.tableId, playerId })
      continue
    }

    const [seat] = seatEntry
    const updatedSeats = { ...table.seats, [seat]: null }

    // If no human players remain, terminate the table
    const remainingHuman = Object.values(updatedSeats).find((id) => id && !id.startsWith('bot:'))
    if (!remainingHuman) {
      terminatedTables.push(table)
      await terminateTable(redis, table.tableId)
      console.log('Table terminated on logout — no human players remain:', { tableId: table.tableId, playerId, seat })
      continue
    }

    // Transfer host if the departing player was the host
    const newHostId = table.hostPlayerId === playerId ? remainingHuman : table.hostPlayerId
    const updated = { ...table, seats: updatedSeats, hostPlayerId: newHostId }
    await saveTable(redis, updated)
    updatedTables.push(updated)
    console.log('Player removed from table on logout:', { tableId: table.tableId, playerId, seat })
  }
  return { updated: updatedTables, terminated: terminatedTables }
}

/**
 * Remove the requesting player from a table's seat.
 *
 * - If the table is 'waiting': the seat is vacated (set to null).
 * - If the table is 'playing': the seat is taken over by a bot (`bot:<seat>`)
 *   so the game can continue uninterrupted (see PRD Section 6.4.7).
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} playerId
 * @returns {Promise<{ table: TableState, seat: string, wasPlaying: boolean }>}
 * @throws {Error} If the table is not found or the player is not seated
 */
export async function leaveTable(redis, tableId, playerId) {
  const table = await getTable(redis, tableId)
  if (!table) {
    throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
  }
  const seatEntry = Object.entries(table.seats).find(([, id]) => id === playerId)
  if (!seatEntry) {
    const observers = table.observers || []
    if (observers.includes(playerId)) {
      const updatedObservers = observers.filter((id) => id !== playerId)
      const updated = { ...table, observers: updatedObservers }
      await saveTable(redis, updated)
      console.log('Observer left table:', { tableId, playerId })
      return { table: updated, wasObserver: true }
    }
    throw Object.assign(new Error('You are not at this table'), { code: 'NOT_SEATED' })
  }
  const [seat] = seatEntry

  if (table.status === 'playing') {
    const botId = `bot:${seat}`
    const updated = { ...table, seats: { ...table.seats, [seat]: botId } }
    await saveTable(redis, updated)
    console.log('Player left in-progress game, replaced by bot:', { tableId, playerId, seat, botId })
    return { table: updated, seat, wasPlaying: true }
  }

  const updatedSeats = { ...table.seats, [seat]: null }

  // If no human players remain after this seat is vacated, terminate the table
  const remainingHuman = Object.values(updatedSeats).find((id) => id && !id.startsWith('bot:'))
  if (!remainingHuman) {
    await terminateTable(redis, tableId)
    console.log('Table terminated — no human players remain:', { tableId, playerId, seat })
    return { terminated: true, seat }
  }

  // If the departing player was the host, transfer host to the next seated human
  let newHostId = table.hostPlayerId
  if (table.hostPlayerId === playerId) {
    newHostId = remainingHuman
    console.log('Host left table, transferring host:', { tableId, oldHost: playerId, newHost: newHostId })
  }

  const updated = { ...table, seats: updatedSeats, hostPlayerId: newHostId }
  await saveTable(redis, updated)
  console.log('Player left waiting table:', { tableId, playerId, seat })
  return { table: updated, seat, wasPlaying: false }
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
    const isObserver = (table.observers || []).includes(playerId)
    if (!seated && !isObserver) continue
    if (table.status === 'playing') {
      const gameState = await getGameState(redis, entry.tableId)
      if (gameState && gameState.phase === 'game_over') continue
    }
    return entry.tableId
  }
  return null
}

/**
 * Move a seated player from their current seat to a different empty seat.
 * Only allowed while the table is in 'waiting' status.
 *
 * Uses WATCH/MULTI/EXEC (optimistic locking) to prevent a TOCTOU race where a
 * concurrent `markTablePlaying` call could transition the table to 'playing' between
 * our read and write — which would otherwise cause changeSeat to silently overwrite
 * the in-progress game state with a stale 'waiting' snapshot.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} playerId
 * @param {'north'|'east'|'south'|'west'} newSeat
 * @returns {Promise<{ table: TableState, oldSeat: string, newSeat: string }>}
 * @throws {Error} If the table is not found, game already started, new seat is taken, or player not seated
 */
export async function changeSeat(redis, tableId, playerId, newSeat) {
  const validSeats = ['north', 'east', 'south', 'west']
  if (!validSeats.includes(newSeat)) {
    throw Object.assign(new Error(`Invalid seat: ${newSeat}`), { code: 'INVALID_SEAT' })
  }

  const key = `table:${tableId}`
  const MAX_RETRIES = 3

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const result = await redis.executeIsolated(async (isolatedClient) => {
      // WATCH the table key — if anything modifies it before EXEC, the transaction aborts
      await isolatedClient.watch(key)

      const raw = await isolatedClient.get(key)
      if (!raw) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
      }

      const table = JSON.parse(raw)

      if (table.status === 'playing') {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Cannot change seats once the game has started'), { code: 'GAME_IN_PROGRESS' })
      }

      const currentSeat = Object.entries(table.seats).find(([, id]) => id === playerId)?.[0]
      if (!currentSeat) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('You are not seated at this table'), { code: 'NOT_SEATED' })
      }

      if (currentSeat === newSeat) {
        await isolatedClient.unwatch()
        return { table, oldSeat: currentSeat, newSeat }
      }

      if (table.seats[newSeat] !== null) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Seat is already taken'), { code: 'SEAT_TAKEN' })
      }

      const updatedSeats = { ...table.seats, [currentSeat]: null, [newSeat]: playerId }
      const updated = { ...table, seats: updatedSeats }

      // Atomically write — exec() returns null if the key was modified since WATCH
      const txResult = await isolatedClient
        .multi()
        .set(key, JSON.stringify(updated), { EX: TABLE_TTL_SECONDS })
        .exec()

      if (txResult === null) {
        // Key was modified concurrently (e.g., game started) — signal caller to retry
        return null
      }

      console.log('Player changed seat:', { tableId, playerId, oldSeat: currentSeat, newSeat })
      return { table: updated, oldSeat: currentSeat, newSeat }
    })

    if (result !== null) {
      return result
    }
    // result === null means the transaction was aborted — retry
  }

  throw Object.assign(
    new Error('Seat change could not be completed due to concurrent table updates — please try again'),
    { code: 'CONCURRENT_MODIFICATION' },
  )
}

/**
 * List all open (waiting) tables from the lobby index.
 * Fetches full table state for each waiting entry to include seat info.
 *
 * @param {import('redis').RedisClientType} redis
 * @returns {Promise<Array<{ tableId: string, name: string|null, hostPlayerId: string, seats: object, seatsAvailable: number }>>}
 */
/**
 * Create a join-link token for a table. Only the host may generate one.
 * The token is stored in Redis and expires with the same TTL as the table.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} requestingPlayerId
 * @returns {Promise<string>} The token
 */
export async function createJoinLink(redis, tableId, requestingPlayerId) {
  const table = await getTable(redis, tableId)
  if (!table) {
    throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
  }
  if (table.hostPlayerId !== requestingPlayerId) {
    throw Object.assign(new Error('Only the host can generate a join link'), { code: 'FORBIDDEN' })
  }
  const token = uuidv4()
  const key = `joinlink:${token}`
  await redis.set(key, JSON.stringify({ tableId, createdAt: new Date().toISOString() }), { EX: TABLE_TTL_SECONDS })
  console.log('Join link created:', { tableId, tokenPrefix: token.slice(0, 8) })
  return token
}

/**
 * Validate and consume a join-link token. Returns the associated tableId if
 * the token is valid and the table still exists, otherwise throws.
 *
 * The token is single-use: it is deleted from Redis upon successful
 * validation so it cannot be reused by another player.
 *
 * Callers that seat a player via a validated join link intentionally bypass
 * the table's joinPolicy — the link itself serves as authorization from the
 * host.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} token
 * @returns {Promise<string>} tableId
 */
export async function validateJoinLink(redis, token) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(token)) {
    throw Object.assign(new Error('Invalid or expired join link'), { code: 'FORBIDDEN' })
  }
  const key = `joinlink:${token}`
  const raw = await redis.get(key)
  if (!raw) {
    throw Object.assign(new Error('Invalid or expired join link'), { code: 'FORBIDDEN' })
  }
  const { tableId } = JSON.parse(raw)
  const table = await getTable(redis, tableId)
  if (!table) {
    await redis.del(key)
    throw Object.assign(new Error('Table no longer exists'), { code: 'NOT_FOUND' })
  }
  return { tableId, key }
}

/**
 * Create a shareable spectator link for a table (host only).
 * The token is stored in Redis and expires with the table TTL.
 * Unlike join links, spectator links grant observe-only access.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} requestingPlayerId
 * @returns {Promise<string>} The token
 */
export async function createSpectatorLink(redis, tableId, requestingPlayerId) {
  const table = await getTable(redis, tableId)
  if (!table) {
    throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
  }
  if (!table.spectating) {
    throw Object.assign(new Error('Spectating is disabled for this table'), { code: 'FORBIDDEN' })
  }
  if (table.hostPlayerId !== requestingPlayerId) {
    throw Object.assign(new Error('Only the host can generate a spectator link'), { code: 'FORBIDDEN' })
  }
  const token = uuidv4()
  const key = `spectatorlink:${token}`
  await redis.set(key, JSON.stringify({ tableId, createdAt: new Date().toISOString() }), { EX: TABLE_TTL_SECONDS })
  console.log('Spectator link created:', { tableId, tokenPrefix: token.slice(0, 8) })
  return token
}

/**
 * Validate a spectator-link token. Returns the associated tableId if
 * the token is valid and the table still exists, otherwise throws.
 *
 * Spectator links are multi-use — they are NOT deleted after validation.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} token
 * @returns {Promise<{ tableId: string }>}
 */
export async function validateSpectatorLink(redis, token) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(token)) {
    throw Object.assign(new Error('Invalid or expired spectator link'), { code: 'FORBIDDEN' })
  }
  const key = `spectatorlink:${token}`
  const raw = await redis.get(key)
  if (!raw) {
    throw Object.assign(new Error('Invalid or expired spectator link'), { code: 'FORBIDDEN' })
  }
  const { tableId } = JSON.parse(raw)
  const table = await getTable(redis, tableId)
  if (!table) {
    await redis.del(key)
    throw Object.assign(new Error('Table no longer exists'), { code: 'NOT_FOUND' })
  }
  if (!table.spectating) {
    throw Object.assign(new Error('Spectating is disabled for this table'), { code: 'FORBIDDEN' })
  }
  return { tableId }
}

/**
 * Mark a player as spectator-only for a table. Spectator-only players
 * cannot sit down even if join policy would allow it.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} playerId
 */
export async function markPlayerAsSpectator(redis, tableId, playerId) {
  const key = `spectators:${tableId}`
  await redis.sAdd(key, playerId)
  await redis.expire(key, TABLE_TTL_SECONDS)
}

/**
 * Check if a player is marked as spectator-only for a table.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} playerId
 * @returns {Promise<boolean>}
 */
export async function isSpectatorOnly(redis, tableId, playerId) {
  const key = `spectators:${tableId}`
  return redis.sIsMember(key, playerId)
}

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
