/**
 * Manages the card-play input blocking state for the game screen.
 *
 * Input is blocked from the moment a card is submitted until both:
 *  1. The card-play animation completes (stubbed until Slice 2 ships)
 *  2. The end-of-trick hold window expires
 *
 * A TURN_CHANGED event or poll arriving during the block window must not
 * re-enable input — the block is cleared only by an explicit unblock() call
 * from the code that owns the hold timer (and, in Slice 2, the animation).
 */
export function createInputBlocker() {
  let blocked = false

  return {
    /** Block card-play input immediately (call when a card play is submitted). */
    block() { blocked = true },

    /**
     * Unblock card-play input.
     * Call only when both the hold window and any card animation have finished.
     */
    unblock() { blocked = false },

    /** Returns true while input should be suppressed. */
    isBlocked() { return blocked },
  }
}
