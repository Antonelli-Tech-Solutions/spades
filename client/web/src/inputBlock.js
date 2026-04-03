/**
 * Creates an input blocker instance that tracks whether card-play input
 * should be disabled. The blocker is owned by a single game-screen mount.
 *
 * Slice 2 hook: when animation support ships, move the `unblock()` call
 * inside the animation-complete promise inside `startHold` in game.js.
 */
export function createInputBlocker() {
  let blocked = false

  return {
    /** Disable card-play input. Safe to call when already blocked. */
    block() { blocked = true },
    /** Re-enable card-play input. Safe to call when already unblocked. */
    unblock() { blocked = false },
    /** Returns true if card-play input is currently disabled. */
    isBlocked() { return blocked },
  }
}
