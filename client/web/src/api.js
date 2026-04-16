/**
 * API client — thin wrappers around fetch for auth endpoints.
 *
 * Each function accepts an optional `fetchFn` parameter so that unit tests
 * can inject a mock without patching the global.
 */

/**
 * Register a new player account.
 * @param {{ email: string, username: string, password: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ playerId: string, message: string }>}
 */
export async function registerUser({ email, username, password }, fetchFn = globalThis.fetch) {
  const res = await fetchFn('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, password }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Registration failed.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Request a new verification email for an unverified account.
 * Always returns successfully — the server does not reveal whether the email
 * exists or is already verified.
 * @param {{ email: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ message: string }>}
 */
export async function resendVerification({ email }, fetchFn = globalThis.fetch) {
  const res = await fetchFn('/api/auth/resend-verification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to resend verification email.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Request a password reset email for the given address.
 * Always resolves — the server does not reveal whether the email exists.
 * @param {{ email: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ message: string }>}
 */
export async function forgotPassword({ email }, fetchFn = globalThis.fetch) {
  const res = await fetchFn('/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to send reset email.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Reset a player's password using a valid reset token.
 * @param {{ token: string, newPassword: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ message: string }>}
 */
export async function resetPassword({ token, newPassword }, fetchFn = globalThis.fetch) {
  const res = await fetchFn('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, newPassword }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to reset password.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Create a new table. Requires a valid session.
 * @param {{ name?: string, visibility?: string, joinPolicy?: string, spectating?: boolean, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ tableId: string, name: string|null, visibility: string, joinPolicy: string, spectating: boolean }>}
 */
export async function createTable({ name, visibility, joinPolicy, spectating, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const payload = { name: name || null }
  if (visibility !== undefined) payload.visibility = visibility
  if (joinPolicy !== undefined) payload.joinPolicy = joinPolicy
  if (spectating !== undefined) payload.spectating = spectating
  const res = await fetchFn('/api/tables', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify(payload),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to create table.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * List all open (waiting) tables. Requires a valid session.
 * @param {{ sessionId: string, playerId: string }} auth
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ tables: Array<{ tableId: string, name: string|null, seats: object, seatsAvailable: number }> }>}
 */
export async function listTables({ sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn('/api/tables', {
    headers: {
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to list tables.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Sit at a seat at a table. Requires a valid session.
 * @param {{ tableId: string, seat: string, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ tableId: string, seat: string }>}
 */
export async function sitAtTable({ tableId, seat, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/sit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({ seat }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to sit at table.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Get the current game state for a table (filtered to the requesting player's view).
 * @param {{ tableId: string, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<object>} Player-specific game state
 */
export async function getGameState({ tableId, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/state`, {
    headers: {
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to get game state.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Place a bid during the bidding phase.
 * @param {{ tableId: string, bid: number|'nil'|'blind_nil', sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<object>} Updated player-specific game state
 */
export async function placeBid({ tableId, bid, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/bid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({ bid }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to place bid.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Play a card during the playing phase.
 * @param {{ tableId: string, card: { suit: string, rank: string }, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<object>} Updated player-specific game state
 */
export async function playCard({ tableId, card, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/play`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({ card }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to play card.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Submit cards for the blind nil exchange.
 * @param {{ tableId: string, cards: Array<{suit: string, rank: string}>, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<object>} Updated player-specific game state
 */
export async function submitBlindNilExchange({ tableId, cards, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/blind-nil-exchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({ cards }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to submit blind nil exchange.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Reveal the player's hand during the Blind Nil eligibility window.
 * @param {{ tableId: string, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<object>} Updated player-specific game state including myHand
 */
export async function revealHand({ tableId, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/reveal-hand`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to reveal hand.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Add a bot player to an empty seat at a table (host only).
 * @param {{ tableId: string, seat: string, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ tableId: string, seat: string }>}
 */
export async function addBotToTable({ tableId, seat, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/add-bot`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({ seat }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to add bot.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Join a table as an observer (not seated). Requires a valid session.
 * @param {{ tableId: string, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ tableId: string }>}
 */
export async function joinTableAsObserver({ tableId, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to join table.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Stand up from a seat, becoming an observer. Requires a valid session.
 * @param {{ tableId: string, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ tableId: string, previousSeat: string }>}
 */
export async function standFromSeat({ tableId, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/stand`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to stand from seat.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Leave a waiting table, removing the player from their seat.
 * @param {{ tableId: string, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ message: string }>}
 */
export async function leaveTable({ tableId, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/leave`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to leave table.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Change the player's seat to a different empty seat (waiting tables only).
 * @param {{ tableId: string, seat: string, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ tableId: string, seat: string }>}
 */
export async function changeSeat({ tableId, seat, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/change-seat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({ seat }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to change seat.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Host-only: move a seated player to a different seat (waiting tables only).
 * @param {{ tableId: string, targetPlayerId: string, seat: string, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ tableId: string, seat: string }>}
 */
export async function assignSeat({ tableId, targetPlayerId, seat, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/assign-seat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({ playerId: targetPlayerId, seat }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to assign seat.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Terminate a game (host only). Works in both waiting and playing phases.
 * @param {{ tableId: string, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ message: string }>}
 */
export async function terminateGame({ tableId, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/terminate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to terminate game.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Kick a player from the table (host only).
 * @param {{ tableId: string, targetPlayerId: string, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<object>}
 */
export async function kickPlayer({ tableId, targetPlayerId, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/kick`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({ playerId: targetPlayerId }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to kick player.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Log out the current session.
 * @param {{ sessionId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ message: string }>}
 */
export async function logoutUser({ sessionId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn('/api/auth/logout', {
    method: 'POST',
    headers: { 'x-session-id': sessionId },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Logout failed.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Get the active table for the authenticated player.
 * Returns { tableId } where tableId is the UUID of the table the player is seated at,
 * or null if the player is not currently seated at any active table.
 * @param {{ sessionId: string, playerId: string }} auth
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ tableId: string|null }>}
 */
export async function getActiveTable({ sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn('/api/player/table', {
    headers: {
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to get active table.')
    err.status = res.status
    throw err
  }
  return body
}

export async function getBuildInfo(fetchFn = globalThis.fetch) {
  const res = await fetchFn('/api/build-info')
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to fetch build info.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Transfer host privileges to another seated human player.
 * @param {{ tableId: string, targetPlayerId: string, sessionId: string, playerId: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ tableId: string, hostPlayerId: string, newHostSeat: string }>}
 */
export async function transferHost({ tableId, targetPlayerId, sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn(`/api/tables/${tableId}/transfer-host`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
    body: JSON.stringify({ playerId: targetPlayerId }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to transfer host.')
    err.status = res.status
    throw err
  }
  return body
}

/**
 * Get the authenticated player's friends list, enriched with presence status.
 * Each friend includes: playerId, username, since, presenceStatus
 * ('online' | 'in-game' | 'offline'), and tableInfo ({ tableName } | null).
 * @param {{ sessionId: string, playerId: string }} auth
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ friends: Array<object>, pending: Array<object> }>}
 */
export async function getFriends({ sessionId, playerId }, fetchFn = globalThis.fetch) {
  const res = await fetchFn('/api/friends', {
    headers: {
      'x-session-id': sessionId,
      'x-player-id': playerId,
    },
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Failed to get friends.')
    err.status = res.status
    throw err
  }
  return body
}

export async function loginUser({ email, password }, fetchFn = globalThis.fetch) {
  const res = await fetchFn('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(body.error || 'Login failed.')
    err.status = res.status
    throw err
  }
  return body
}
