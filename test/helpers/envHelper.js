/**
 * Minimal helpers for saving and restoring environment variables in tests.
 */

/**
 * Save the current value of an env var. Returns undefined if the var is not set.
 * @param {string} key
 * @returns {string|undefined}
 */
export function saveEnv(key) {
  return Object.hasOwn(process.env, key) ? process.env[key] : undefined
}

/**
 * Restore an env var to a previously saved value.
 * If savedValue is undefined the var is deleted; otherwise it is set.
 * @param {string} key
 * @param {string|undefined} savedValue
 */
export function restoreEnv(key, savedValue) {
  if (savedValue !== undefined) {
    process.env[key] = savedValue
  } else {
    delete process.env[key]
  }
}
