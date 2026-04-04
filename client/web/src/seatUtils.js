// Clockwise seat order as viewed from above the table (N → E → S → W → N).
// In a standard card game, play passes to the LEFT, which is the next seat
// in this clockwise order.
export const CW = ['north', 'east', 'south', 'west']

// Returns seats from the current player's perspective:
//   me = bottom, left = clockwise neighbour, across = partner, right = counter-clockwise neighbour
// Play passes to the LEFT (clockwise): e.g. South's left neighbour is West.
export function relSeats(seat) {
  const i = CW.indexOf(seat)
  return {
    me: CW[i],
    left: CW[(i + 1) % 4],    // clockwise neighbour — play passes here
    across: CW[(i + 2) % 4],
    right: CW[(i + 3) % 4],   // counter-clockwise neighbour
  }
}
