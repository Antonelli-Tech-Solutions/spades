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
 * Log in with email and password.
 * @param {{ email: string, password: string }} data
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ sessionId: string, playerId: string, username: string }>}
 */
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
