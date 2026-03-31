/**
 * Pure form-validation helpers — no DOM dependencies.
 * Used by both the browser screens and the Node unit test suite.
 */

/**
 * Validates registration form input.
 * @param {{ email: string, username: string, password: string }} fields
 * @returns {string|null} Error message, or null if valid.
 */
export function validateRegisterForm({ email, username, password }) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return 'A valid email address is required.'
  }
  if (!username || typeof username !== 'string' || username.trim().length < 2) {
    return 'Username must be at least 2 characters.'
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters.'
  }
  return null
}

/**
 * Validates login form input.
 * @param {{ email: string, password: string }} fields
 * @returns {string|null} Error message, or null if valid.
 */
export function validateLoginForm({ email, password }) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return 'A valid email address is required.'
  }
  if (!password || typeof password !== 'string' || !password.length) {
    return 'Password is required.'
  }
  return null
}
