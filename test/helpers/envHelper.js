/**
 * Environment variable save/restore helpers (issue #333).
 *
 * Replaces the 5-line save/restore pattern that was copy-pasted ~15 times:
 *
 *   if (saved !== undefined) {
 *     process.env[KEY] = saved
 *   } else {
 *     delete process.env[KEY]
 *   }
 */

/**
 * Capture the current value of an environment variable.
 * Returns the string value, or undefined if the variable is not set.
 */
export function saveEnv(key) {
  return Object.hasOwn(process.env, key) ? process.env[key] : undefined
}

/**
 * Restore an environment variable to a previously saved value.
 * If savedValue is undefined the variable is deleted; otherwise it is set.
 */
export function restoreEnv(key, savedValue) {
  if (savedValue !== undefined) {
    process.env[key] = savedValue
  } else {
    delete process.env[key]
  }
}
