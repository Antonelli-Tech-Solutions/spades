import { TEAM_FOR_SEAT } from './bid.js'

const TEAMS = ['ns', 'ew']

function getTeamSeats(team) {
  return Object.keys(TEAM_FOR_SEAT).filter((s) => TEAM_FOR_SEAT[s] === team)
}

function getTeamTotalTricks(team, tricksWon) {
  return getTeamSeats(team).reduce((sum, seat) => sum + tricksWon[seat], 0)
}

function getNilBidders(team, bids) {
  return getTeamSeats(team).filter((s) => bids[s] === 'nil' || bids[s] === 'blind_nil')
}

/**
 * Score a completed hand.
 *
 * Returns score delta and new bags earned this hand. Bag penalty deduction is
 * handled separately in applyBagPenalties so the caller can apply both in one
 * step with full visibility.
 *
 * @param {{ bids, teamBids, tricksWon }} hand
 * @returns {{ scoreDelta: {ns,ew}, newBags: {ns,ew} }}
 */
export function scoreHand({ bids, teamBids, tricksWon }) {
  const scoreDelta = { ns: 0, ew: 0 }
  const newBags = { ns: 0, ew: 0 }

  for (const team of TEAMS) {
    const nilBidders = getNilBidders(team, bids)
    const isDoubleNil = nilBidders.length === 2

    // --- Score each individual nil / blind nil bid ---
    for (const seat of nilBidders) {
      const bid = bids[seat]
      const points = bid === 'blind_nil' ? 100 : 50
      if (tricksWon[seat] === 0) {
        scoreDelta[team] += points // Nil/blind nil made
      } else {
        scoreDelta[team] -= points // Nil/blind nil failed
      }
      if (isDoubleNil) {
        // Every trick a player takes in a double-nil situation is a bag
        newBags[team] += tricksWon[seat]
      }
    }

    if (isDoubleNil) continue // No team bid scoring in double nil

    // --- Score the team bid ---
    const teamBid = teamBids[team]
    if (teamBid === null) continue // Defensive — shouldn't happen outside double nil

    const totalTricks = getTeamTotalTricks(team, tricksWon)

    if (teamBid === 0) {
      // Team bid of 0: every trick is a bag, no positive/negative from made/missed scoring
      newBags[team] += totalTricks
    } else if (totalTricks >= teamBid) {
      scoreDelta[team] += teamBid * 10
      newBags[team] += totalTricks - teamBid
    } else {
      scoreDelta[team] -= teamBid * 10
    }
  }

  return { scoreDelta, newBags }
}

/**
 * Apply bag penalties to scores.
 *
 * Every 10 accumulated bags deducts 100 points and resets that group of 10.
 *
 * @param {{ ns: number, ew: number }} scores - Current cumulative scores
 * @param {{ ns: number, ew: number }} bags - Current cumulative bag counts (before this hand)
 * @param {{ ns: number, ew: number }} newBags - Bags earned this hand
 * @returns {{ scores: {ns,ew}, bags: {ns,ew} }}
 */
export function applyBagPenalties(scores, bags, newBags) {
  const updatedScores = { ...scores }
  const updatedBags = { ...bags }

  for (const team of TEAMS) {
    const total = updatedBags[team] + newBags[team]
    const penalties = Math.floor(total / 10)
    updatedBags[team] = total % 10
    updatedScores[team] -= penalties * 100
  }

  return { scores: updatedScores, bags: updatedBags }
}

/**
 * Check whether the current scores trigger a win or loss condition.
 *
 * Win: first to 250+ wins; both at 250+ → higher score wins; exact tie → null (play another).
 * Loss: -250 or lower is an immediate loss; same tie-break rules apply.
 *
 * @param {{ ns: number, ew: number }} scores
 * @returns {{ winner: string, loser: string } | null}
 */
export function checkWinLoss(scores) {
  const nsWins = scores.ns >= 250
  const ewWins = scores.ew >= 250
  const nsLoses = scores.ns <= -250
  const ewLoses = scores.ew <= -250

  // Win condition: one or both teams have reached 250
  if (nsWins || ewWins) {
    if (nsWins && ewWins) {
      // Tie at exactly 250 — play another hand
      if (scores.ns === scores.ew) return null
      const winner = scores.ns > scores.ew ? 'ns' : 'ew'
      return { winner, loser: winner === 'ns' ? 'ew' : 'ns' }
    }
    const winner = nsWins ? 'ns' : 'ew'
    return { winner, loser: winner === 'ns' ? 'ew' : 'ns' }
  }

  // Loss condition: one or both teams have hit -250 or below
  if (nsLoses || ewLoses) {
    if (nsLoses && ewLoses) {
      // Both lost — higher score wins
      if (scores.ns === scores.ew) return null
      const winner = scores.ns > scores.ew ? 'ns' : 'ew'
      return { winner, loser: winner === 'ns' ? 'ew' : 'ns' }
    }
    const loser = nsLoses ? 'ns' : 'ew'
    return { winner: loser === 'ns' ? 'ew' : 'ns', loser }
  }

  return null
}
