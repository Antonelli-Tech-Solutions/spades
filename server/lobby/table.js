import { v4 as uuidv4 } from 'uuid'
import { substitutePlayerWithBot } from '../game/state.js'
import { setPresenceOnline, setPresencePlaying } from '../presence.js'

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

  // Add to the lobby index for public tables; all tables tracked in lobby:all for player lookup
  if (visibility === 'public') {
    await redis.hSet('lobby:tables', tableId, JSON.stringify({ tableId, hostPlayerId, name, status: 'waiting' }))
  }
  await redis.hSet('lobby:all', tableId, JSON.stringify({ tableId, hostPlayerId, name, status: 'waiting' }))

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
  const specKey = `spectators:${table.tableId}`
  const exists = await redis.exists(specKey)
  if (exists) {
    await redis.expire(specKey, TABLE_TTL_SECONDS)
  }
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
export async function sitAtTable(redis, tableId, playerId, seat, { policyDeps } = {}) {
  const validSeats = ['north', 'east', 'south', 'west']
  if (!validSeats.includes(seat)) {
    throw Object.assign(new Error(`Invalid seat: ${seat}`), { code: 'INVALID_SEAT' })
  }

  const key = `table:${tableId}`
  const MAX_RETRIES = 3

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const result = await redis.executeIsolated(async (isolatedClient) => {
      await isolatedClient.watch(key)

      const raw = await isolatedClient.get(key)
      if (!raw) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
      }

      const table = JSON.parse(raw)

      const spectatorOnly = await isSpectatorOnly(redis, tableId, playerId)
      if (spectatorOnly) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Spectators cannot sit at the table'), { code: 'FORBIDDEN' })
      }

      if (table.status === 'playing') {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Game already in progress'), { code: 'GAME_IN_PROGRESS' })
      }

      const currentSeat = Object.entries(table.seats).find(([, id]) => id === playerId)?.[0]
      if (currentSeat === seat) {
        await isolatedClient.unwatch()
        return table
      }
      if (currentSeat) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Player is already seated at this table'), { code: 'ALREADY_SEATED' })
      }
      if (table.seats[seat] !== null) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Seat is already taken'), { code: 'SEAT_TAKEN' })
      }

      if (policyDeps) {
        await enforceJoinPolicyForSit(redis, policyDeps.db, table, playerId, { areFriends: policyDeps.areFriends })
      }

      const updatedObservers = (table.observers || []).filter((id) => id !== playerId)
      const updated = {
        ...table,
        seats: { ...table.seats, [seat]: playerId },
        observers: updatedObservers,
      }

      const txResult = await isolatedClient
        .multi()
        .set(key, JSON.stringify(updated), { EX: TABLE_TTL_SECONDS })
        .exec()

      if (txResult === null) {
        return null
      }

      console.log('Player seated:', { tableId, playerId, seat })
      return updated
    })

    if (result !== null) {
      await setPresencePlaying(redis, playerId, tableId)
      return result
    }
  }

  throw Object.assign(
    new Error('Sit could not be completed due to concurrent table updates — please try again'),
    { code: 'CONCURRENT_MODIFICATION' },
  )
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
export async function joinTable(redis, tableId, playerId, { asSpectator = false } = {}) {
  const table = await getTable(redis, tableId)
  if (!table) {
    throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
  }
  const seated = Object.values(table.seats).includes(playerId)
  if (seated) return table
  if (!table.spectating) {
    throw Object.assign(new Error('Spectating is not enabled for this table'), { code: 'FORBIDDEN' })
  }
  const observers = table.observers || []
  if (observers.includes(playerId)) return table
  if (observers.length >= MAX_OBSERVERS) {
    throw Object.assign(new Error('Table has reached the maximum number of observers'), { code: 'OBSERVERS_FULL' })
  }
  if (asSpectator) {
    await markPlayerAsSpectator(redis, tableId, playerId)
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
  await setPresenceOnline(redis, playerId)
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
 * Transfer host privileges to another seated human player.
 * Works in both waiting and playing states.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} requestingPlayerId
 * @param {string} targetPlayerId
 * @returns {Promise<TableState>}
 */
export async function transferHost(redis, tableId, requestingPlayerId, targetPlayerId) {
  const key = `table:${tableId}`
  const MAX_RETRIES = 3

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const result = await redis.executeIsolated(async (isolatedClient) => {
      await isolatedClient.watch(key)

      const raw = await isolatedClient.get(key)
      if (!raw) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
      }

      const table = JSON.parse(raw)

      if (table.hostPlayerId !== requestingPlayerId) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Only the host can transfer host privileges'), { code: 'FORBIDDEN' })
      }

      if (requestingPlayerId === targetPlayerId) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Cannot transfer host to yourself'), { code: 'INVALID_TARGET' })
      }

      const targetSeat = Object.entries(table.seats).find(([, id]) => id === targetPlayerId)
      if (!targetSeat) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Target player is not seated at this table'), { code: 'NOT_SEATED' })
      }

      if (targetPlayerId.startsWith('bot:')) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Cannot transfer host to a bot'), { code: 'INVALID_TARGET' })
      }

      const updated = { ...table, hostPlayerId: targetPlayerId }

      const txResult = await isolatedClient
        .multi()
        .set(key, JSON.stringify(updated), { EX: TABLE_TTL_SECONDS })
        .exec()

      if (txResult === null) {
        return null
      }

      // Update lobby indices with new host
      if (updated.visibility === 'public') {
        await isolatedClient.hSet('lobby:tables', tableId, JSON.stringify({
          tableId,
          hostPlayerId: targetPlayerId,
          name: updated.name,
          status: updated.status,
        }))
      }
      await isolatedClient.hSet('lobby:all', tableId, JSON.stringify({
        tableId,
        hostPlayerId: targetPlayerId,
        name: updated.name,
        status: updated.status,
      }))

      console.log('Host transferred:', { tableId, from: requestingPlayerId, to: targetPlayerId })
      return updated
    })

    if (result !== null) {
      return result
    }
  }

  throw Object.assign(
    new Error('Host transfer could not be completed due to concurrent table updates — please try again'),
    { code: 'CONCURRENT_MODIFICATION' },
  )
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
  if (table.visibility === 'public') {
    await redis.hSet('lobby:tables', tableId, JSON.stringify({
      tableId,
      hostPlayerId: table.hostPlayerId,
      status: 'playing',
    }))
  }
  await redis.hSet('lobby:all', tableId, JSON.stringify({
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
  const raw = await redis.hGetAll('lobby:all')
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
      await setPresenceOnline(redis, playerId)
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
      await setPresenceOnline(redis, playerId)
      console.log('Table terminated on logout — no human players remain:', { tableId: table.tableId, playerId, seat })
      continue
    }

    // Transfer host if the departing player was the host
    const newHostId = table.hostPlayerId === playerId ? remainingHuman : table.hostPlayerId
    const updated = { ...table, seats: updatedSeats, hostPlayerId: newHostId }
    await saveTable(redis, updated)
    await setPresenceOnline(redis, playerId)
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
    await setPresenceOnline(redis, playerId)
    console.log('Player left in-progress game, replaced by bot:', { tableId, playerId, seat, botId })
    return { table: updated, seat, wasPlaying: true }
  }

  const updatedSeats = { ...table.seats, [seat]: null }

  // If no human players remain after this seat is vacated, terminate the table
  const remainingHuman = Object.values(updatedSeats).find((id) => id && !id.startsWith('bot:'))
  if (!remainingHuman) {
    await terminateTable(redis, tableId)
    await setPresenceOnline(redis, playerId)
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
  await setPresenceOnline(redis, playerId)
  console.log('Player left waiting table:', { tableId, playerId, seat })
  return { table: updated, seat, wasPlaying: false }
}

/**
 * Kick a player from the table. Only the host can kick players.
 * In an active game, the kicked player's seat is filled by a bot.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} requestingPlayerId
 * @param {string} targetPlayerId
 * @returns {Promise<Object>}
 * @throws {Error} If the table is not found, requester is not host, or target is not at the table
 */
export async function kickPlayer(redis, tableId, requestingPlayerId, targetPlayerId) {
  const table = await getTable(redis, tableId)
  if (!table) {
    throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
  }
  if (table.hostPlayerId !== requestingPlayerId) {
    throw Object.assign(new Error('Only the host can kick players'), { code: 'FORBIDDEN' })
  }
  if (requestingPlayerId === targetPlayerId) {
    throw Object.assign(new Error('Host cannot kick themselves'), { code: 'SELF_KICK' })
  }

  const seatEntry = Object.entries(table.seats).find(([, id]) => id === targetPlayerId)
  const isObserver = (table.observers || []).includes(targetPlayerId)

  if (!seatEntry && !isObserver) {
    throw Object.assign(new Error('Target player is not at this table'), { code: 'NOT_AT_TABLE' })
  }

  if (table.status === 'playing' && seatEntry) {
    const [seat] = seatEntry
    const botId = `bot:${seat}`
    const updatedSeats = { ...table.seats, [seat]: botId }
    const remainingHuman = Object.values(updatedSeats).find((id) => id && !id.startsWith('bot:'))
    if (!remainingHuman) {
      await terminateTable(redis, tableId)
      await setPresenceOnline(redis, targetPlayerId)
      console.log('Kick: table terminated — no human players remain:', { tableId, targetPlayerId, seat })
      return { terminated: true, seat, kickedPlayerId: targetPlayerId }
    }
    const updated = { ...table, seats: updatedSeats }
    await saveTable(redis, updated)
    const gameState = await getGameState(redis, tableId)
    if (gameState) {
      const newState = substitutePlayerWithBot(gameState, seat)
      await saveGameState(redis, tableId, newState)
    }
    if (table.visibility === 'public') {
      await redis.hSet('lobby:tables', tableId, JSON.stringify({ tableId, hostPlayerId: updated.hostPlayerId, name: updated.name, status: updated.status }))
    }
    await setPresenceOnline(redis, targetPlayerId)
    console.log('Kick: player replaced by bot in active game:', { tableId, targetPlayerId, seat, botId })
    return { table: updated, seat, botId, kickedPlayerId: targetPlayerId }
  }

  if (seatEntry) {
    const [seat] = seatEntry
    const updatedSeats = { ...table.seats, [seat]: null }
    const updatedObservers = (table.observers || []).filter((id) => id !== targetPlayerId)
    const updated = { ...table, seats: updatedSeats, observers: updatedObservers }
    await saveTable(redis, updated)
    if (table.visibility === 'public') {
      await redis.hSet('lobby:tables', tableId, JSON.stringify({ tableId, hostPlayerId: updated.hostPlayerId, name: updated.name, status: updated.status }))
    }
    await setPresenceOnline(redis, targetPlayerId)
    console.log('Kick: player removed from seat:', { tableId, targetPlayerId, seat })
    return { table: updated, seat, kickedPlayerId: targetPlayerId }
  }

  const updatedObservers = (table.observers || []).filter((id) => id !== targetPlayerId)
  const updated = { ...table, observers: updatedObservers }
  await saveTable(redis, updated)
  if (table.visibility === 'public') {
    await redis.hSet('lobby:tables', tableId, JSON.stringify({ tableId, hostPlayerId: updated.hostPlayerId, name: updated.name, status: updated.status }))
  }
  console.log('Kick: observer removed:', { tableId, targetPlayerId })
  return { table: updated, kickedPlayerId: targetPlayerId }
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
    await setPresenceOnline(redis, playerId)
    console.log('Table terminated — no human players remain:', { tableId, playerId, seat })
    return { terminated: true, seat }
  }

  // Reassign host to a remaining human if the departing player was the host
  const newHostId = table.hostPlayerId === playerId ? remainingHuman : table.hostPlayerId
  const updated = { ...table, seats: updatedSeats, hostPlayerId: newHostId }
  await saveTable(redis, updated)
  await setPresenceOnline(redis, playerId)
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
  const tokens = await redis.sMembers(`spectatorlinks:${tableId}`)
  const tokenKeys = tokens.map((t) => `spectatorlink:${t}`)
  if (tokenKeys.length > 0) {
    await redis.del(tokenKeys)
  }
  await redis.del(`spectatorlinks:${tableId}`)
  await redis.del(`table:${tableId}`)
  await redis.del(`game:${tableId}`)
  await redis.del(`spectators:${tableId}`)
  await redis.del(`invited:${tableId}`)
  await redis.hDel('lobby:tables', tableId)
  await redis.hDel('lobby:all', tableId)
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
  const raw = await redis.hGetAll('lobby:all')
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
 * Host-only: move a seated player to a different empty seat.
 * Only allowed while the table is in 'waiting' status.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} requestingPlayerId - must be the table host
 * @param {string} targetPlayerId - player to move (must be seated)
 * @param {'north'|'east'|'south'|'west'} targetSeat
 * @returns {Promise<{ table: TableState, oldSeat: string, newSeat: string }>}
 */
export async function assignSeat(redis, tableId, requestingPlayerId, targetPlayerId, targetSeat) {
  const validSeats = ['north', 'east', 'south', 'west']
  if (!validSeats.includes(targetSeat)) {
    throw Object.assign(new Error(`Invalid seat: ${targetSeat}`), { code: 'INVALID_SEAT' })
  }

  const key = `table:${tableId}`
  const MAX_RETRIES = 3

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const result = await redis.executeIsolated(async (isolatedClient) => {
      await isolatedClient.watch(key)

      const raw = await isolatedClient.get(key)
      if (!raw) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
      }

      const table = JSON.parse(raw)

      if (table.hostPlayerId !== requestingPlayerId) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Only the host can assign seats'), { code: 'FORBIDDEN' })
      }

      if (table.status === 'playing') {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Cannot assign seats once the game has started'), { code: 'GAME_IN_PROGRESS' })
      }

      const currentSeat = Object.entries(table.seats).find(([, id]) => id === targetPlayerId)?.[0]
      if (!currentSeat) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Target player is not seated at this table'), { code: 'NOT_SEATED' })
      }

      if (currentSeat === targetSeat) {
        await isolatedClient.unwatch()
        return { table, oldSeat: currentSeat, newSeat: targetSeat }
      }

      if (table.seats[targetSeat] !== null) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Target seat is already occupied'), { code: 'SEAT_TAKEN' })
      }

      const updatedSeats = { ...table.seats, [currentSeat]: null, [targetSeat]: targetPlayerId }
      const updated = { ...table, seats: updatedSeats }

      const txResult = await isolatedClient
        .multi()
        .set(key, JSON.stringify(updated), { EX: TABLE_TTL_SECONDS })
        .exec()

      if (txResult === null) {
        return null
      }

      console.log('Host assigned seat:', { tableId, requestingPlayerId, targetPlayerId, oldSeat: currentSeat, newSeat: targetSeat })
      return { table: updated, oldSeat: currentSeat, newSeat: targetSeat }
    })

    if (result !== null) {
      return result
    }
  }

  throw Object.assign(
    new Error('Seat assignment could not be completed due to concurrent table updates — please try again'),
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
  await redis.sAdd(`spectatorlinks:${tableId}`, token)
  const tableTTL = await redis.ttl(`table:${tableId}`)
  if (tableTTL > 0) {
    await redis.expire(`spectatorlinks:${tableId}`, tableTTL)
  }
  console.log('Spectator link created:', { tableId })
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

/**
 * Arrive at a table as an observer. Like joinTable, but also allows arrival
 * at spectating-disabled tables when the player holds a valid join link
 * (indicated by `hasJoinLink`).
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} playerId
 * @param {{ hasJoinLink?: boolean }} opts
 * @returns {Promise<TableState>}
 */
export async function arriveAtTable(redis, tableId, playerId, { hasJoinLink = false } = {}) {
  const key = `table:${tableId}`
  const MAX_RETRIES = 3

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const result = await redis.executeIsolated(async (isolatedClient) => {
      await isolatedClient.watch(key)

      const raw = await isolatedClient.get(key)
      if (!raw) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Table not found'), { code: 'NOT_FOUND' })
      }

      const table = JSON.parse(raw)
      const seated = Object.values(table.seats).includes(playerId)
      if (seated) {
        await isolatedClient.unwatch()
        return table
      }
      const observers = table.observers || []
      if (observers.includes(playerId)) {
        await isolatedClient.unwatch()
        return table
      }

      if (!table.spectating && !hasJoinLink) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Spectating is not enabled for this table'), { code: 'FORBIDDEN' })
      }

      if (observers.length >= MAX_OBSERVERS) {
        await isolatedClient.unwatch()
        throw Object.assign(new Error('Table has reached the maximum number of observers'), { code: 'OBSERVERS_FULL' })
      }

      const updated = { ...table, observers: [...observers, playerId] }
      const txResult = await isolatedClient
        .multi()
        .set(key, JSON.stringify(updated), { EX: TABLE_TTL_SECONDS })
        .exec()

      if (txResult === null) {
        return null
      }

      console.log('Player arrived at table:', { tableId, playerId })
      return updated
    })

    if (result !== null) {
      return result
    }
  }

  throw Object.assign(
    new Error('Arrival could not be completed due to concurrent table updates — please try again'),
    { code: 'CONCURRENT_MODIFICATION' },
  )
}

/**
 * Mark a player as invited to a table. Invited players can sit at
 * invite-only tables without needing a join link.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} playerId
 */
export async function markPlayerInvited(redis, tableId, playerId) {
  const key = `invited:${tableId}`
  await redis.sAdd(key, playerId)
  await redis.expire(key, TABLE_TTL_SECONDS)
}

/**
 * Check whether a player has been invited to a table.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {string} tableId
 * @param {string} playerId
 * @returns {Promise<boolean>}
 */
export async function isPlayerInvited(redis, tableId, playerId) {
  return redis.sIsMember(`invited:${tableId}`, playerId)
}

/**
 * Enforce the table's join policy. Returns null if the player is allowed
 * to sit, or throws FORBIDDEN if not.
 *
 * - open: anyone may sit
 * - friends-only: the player must be a friend of the host
 * - invite-only: the player must have been invited or used a join link
 *
 * The host always passes policy checks.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {object} db - pg Pool
 * @param {TableState} table
 * @param {string} playerId
 * @param {{ areFriends: function }} deps — injectable for testing
 */
export async function enforceJoinPolicyForSit(redis, db, table, playerId, { areFriends }) {
  if (playerId === table.hostPlayerId) return

  if (table.joinPolicy === 'open') return

  if (table.joinPolicy === 'friends-only') {
    const friends = await areFriends(db, playerId, table.hostPlayerId)
    if (!friends) {
      throw Object.assign(new Error('Only friends of the host may sit at this table'), { code: 'FORBIDDEN' })
    }
    return
  }

  if (table.joinPolicy === 'invite-only') {
    const invited = await isPlayerInvited(redis, table.tableId, playerId)
    if (!invited) {
      throw Object.assign(new Error('You must be invited to sit at this table'), { code: 'FORBIDDEN' })
    }
    return
  }

  throw Object.assign(new Error('Unknown join policy'), { code: 'FORBIDDEN' })
}

/**
 * List public, waiting tables from the lobby index.
 *
 * The `lobby:tables` index only ever stores tables whose visibility is
 * 'public' — friends-only and private tables are deliberately kept out of
 * that index when they are created or when visibility changes. We still
 * defensively skip any non-public table here in case the index ever drifts.
 *
 * Optional filters:
 *   - hasSeats: when true, only include tables with at least one open (null) seat.
 *   - search:   case-insensitive substring match against table.name. When a
 *               non-empty term is supplied, unnamed tables (name=null) are excluded.
 *
 * @param {import('redis').RedisClientType} redis
 * @param {{ hasSeats?: boolean, search?: string }} [options]
 */
export async function listTables(redis, options = {}) {
  const { hasSeats = false, search = '' } = options
  const term = typeof search === 'string' ? search.trim().toLowerCase() : ''
  const raw = await redis.hGetAll('lobby:tables')
  const result = []
  for (const json of Object.values(raw)) {
    const entry = JSON.parse(json)
    if (entry.status !== 'waiting') continue
    const table = await getTable(redis, entry.tableId)
    if (!table || table.status !== 'waiting') continue
    if (table.visibility && table.visibility !== 'public') continue
    const seatsAvailable = Object.values(table.seats).filter((p) => p === null).length
    if (hasSeats && seatsAvailable === 0) continue
    if (term) {
      if (typeof table.name !== 'string') continue
      if (!table.name.toLowerCase().includes(term)) continue
    }
    result.push({
      tableId: table.tableId,
      name: table.name,
      hostPlayerId: table.hostPlayerId,
      seats: table.seats,
      seatsAvailable,
      observerCount: (table.observers || []).length,
      spectating: table.spectating,
      visibility: table.visibility ?? 'public',
      joinPolicy: table.joinPolicy ?? 'open',
      ruleset: table.ruleset ?? 'Standard',
    })
  }
  return result
}

/**
 * Check whether a player has visibility into a table based on its visibility setting.
 *
 * - public: anyone can see
 * - friends-only: only friends of the host can see
 * - private: not visible through the friends list
 *
 * @param {object} db - pg Pool
 * @param {TableState} table
 * @param {string} requesterId
 * @param {{ areFriends: function }} deps
 * @returns {Promise<boolean>}
 */
export async function canSeeTable(db, table, requesterId, { areFriends }) {
  if (requesterId === table.hostPlayerId) return true
  if (table.visibility === 'public') return true
  if (table.visibility === 'friends-only') {
    return areFriends(db, requesterId, table.hostPlayerId)
  }
  return false
}

/**
 * Determine whether the "Go to Table" action should be available for a player
 * looking at a friend's table entry. The action is available when:
 *
 * 1. The table is visible to the requester (canSeeTable), AND
 * 2. Either spectating is enabled, OR the player has seating rights
 *    (i.e. the join policy would let them sit).
 *
 * @param {import('redis').RedisClientType} redis
 * @param {object} db - pg Pool
 * @param {TableState} table
 * @param {string} requesterId
 * @param {{ areFriends: function }} deps
 * @returns {Promise<boolean>}
 */
export async function canGoToTable(redis, db, table, requesterId, { areFriends, knownVisible } = {}) {
  const visible = knownVisible !== undefined ? knownVisible : await canSeeTable(db, table, requesterId, { areFriends })
  if (!visible) return false

  if (table.spectating) return true

  try {
    await enforceJoinPolicyForSit(redis, db, table, requesterId, { areFriends })
    return true
  } catch {
    return false
  }
}
