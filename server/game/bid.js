/** Clockwise seat order. */
const CLOCKWISE = ['north', 'east', 'south', 'west']

/** Team membership for each seat. */
export const TEAM_FOR_SEAT = {
  north: 'ns',
  east: 'ew',
  south: 'ns',
  west: 'ew',
}

/** Partner seat for each seat. */
export function getPartnerSeat(seat) {
  const partners = { north: 'south', south: 'north', east: 'west', west: 'east' }
  return partners[seat]
}

/**
 * Return the 4-seat bidding order (clockwise from player left of dealer).
 * @param {'north'|'east'|'south'|'west'} dealerSeat
 * @returns {string[]}
 */
export function getBiddingOrder(dealerSeat) {
  const idx = CLOCKWISE.indexOf(dealerSeat)
  return [
    CLOCKWISE[(idx + 1) % 4],
    CLOCKWISE[(idx + 2) % 4],
    CLOCKWISE[(idx + 3) % 4],
    CLOCKWISE[(idx + 4) % 4],
  ]
}

/**
 * Return the two seats for a team in the order they appear in the bidding sequence.
 * @param {'ns'|'ew'} team
 * @param {string[]} biddingOrder
 * @returns {[string, string]} [firstBidder, secondBidder]
 */
function getTeamBiddingOrder(team, biddingOrder) {
  return biddingOrder.filter((s) => TEAM_FOR_SEAT[s] === team)
}

/**
 * Whether a player is the second bidder for their team in this hand.
 * @param {string} seat
 * @param {string[]} biddingOrder
 * @returns {boolean}
 */
export function isSecondTeamBidder(seat, biddingOrder) {
  const team = TEAM_FOR_SEAT[seat]
  const members = getTeamBiddingOrder(team, biddingOrder)
  return members[1] === seat
}

/**
 * Whether a player is eligible to bid Blind Nil.
 * Requires their team to be at least 100 points behind the opposing team.
 * @param {{ ns: number, ew: number }} scores
 * @param {string} seat
 * @returns {boolean}
 */
export function isEligibleForBlindNil(scores, seat) {
  const team = TEAM_FOR_SEAT[seat]
  const opposing = team === 'ns' ? 'ew' : 'ns'
  return scores[opposing] - scores[team] >= 100
}

/**
 * Whether a teammate has already bid Blind Nil this hand (only one per team is allowed).
 * @param {{ north: *, east: *, south: *, west: * }} bids - current bids (null means not yet bid)
 * @param {string} seat - the seat checking eligibility
 * @returns {boolean}
 */
export function teamHasBlindNil(bids, seat) {
  const team = TEAM_FOR_SEAT[seat]
  return Object.entries(bids).some(
    ([s, b]) => TEAM_FOR_SEAT[s] === team && b === 'blind_nil',
  )
}

/**
 * Validate whether a bid value is legal (0–13, 'nil', or 'blind_nil').
 * @param {*} bid
 * @returns {boolean}
 */
export function isValidBidValue(bid) {
  if (bid === 'nil' || bid === 'blind_nil') return true
  return Number.isInteger(bid) && bid >= 0 && bid <= 13
}

/**
 * Compute the effective team bids after all 4 players have bid.
 *
 * Rules:
 * - If second bidder bids a number → that number is the team bid.
 * - If second bidder bids nil/blind_nil → first bidder's bid (if a number) is the team bid.
 * - If both bid nil/blind_nil (double nil) → team bid is null (no team target).
 *
 * @param {{ north: *, east: *, south: *, west: * }} bids
 * @param {string[]} biddingOrder
 * @returns {{ ns: number|null, ew: number|null }}
 */
export function computeTeamBids(bids, biddingOrder) {
  const result = { ns: null, ew: null }
  for (const team of ['ns', 'ew']) {
    const [firstSeat, secondSeat] = getTeamBiddingOrder(team, biddingOrder)
    const firstBid = bids[firstSeat]
    const secondBid = bids[secondSeat]
    const firstIsNil = firstBid === 'nil' || firstBid === 'blind_nil'
    const secondIsNil = secondBid === 'nil' || secondBid === 'blind_nil'

    if (firstIsNil && secondIsNil) {
      // Double nil — no team bid target
      result[team] = null
    } else if (secondIsNil) {
      // Second bid nil → first bidder's number is the team target
      result[team] = firstIsNil ? null : firstBid
    } else {
      // Second bid a number → that overrides whatever first bid
      result[team] = secondBid
    }
  }
  return result
}
