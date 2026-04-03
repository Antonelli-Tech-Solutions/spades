const TEAM_FOR_SEAT = { north: 'ns', south: 'ns', east: 'ew', west: 'ew' }
const TEAM_SEATS = { ns: ['north', 'south'], ew: ['east', 'west'] }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatScore(n) {
  if (n > 0) return `+${n}`
  return String(n)
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function bidLabel(bid) {
  if (bid === 'nil') return 'Nil'
  if (bid === 'blind_nil') return 'Blind Nil'
  return String(bid)
}

function renderTeamColumn(summary, team, isUs) {
  const seats = TEAM_SEATS[team]
  const nilBidders = seats.filter((s) => summary.bids[s] === 'nil' || summary.bids[s] === 'blind_nil')
  const isDoubleNil = nilBidders.length === 2
  const totalTricks = seats.reduce((sum, s) => sum + summary.tricksWon[s], 0)

  const rows = []

  // Team total row — omitted when both players bid nil (double nil)
  if (!isDoubleNil) {
    const teamBid = summary.teamBids[team]
    const scoreDisplay = formatScore(summary.scoreDelta[team])
    const bagsEarned = summary.newBags[team]
    rows.push(`
      <div class="summary-team-row">
        <div class="summary-stat">Bid ${esc(String(teamBid ?? 0))}</div>
        <div class="summary-stat">Took ${totalTricks}</div>
        <div class="summary-score ${summary.scoreDelta[team] >= 0 ? 'summary-score-pos' : 'summary-score-neg'}">${esc(scoreDisplay)}</div>
        <div class="summary-stat">+${bagsEarned} bag${bagsEarned !== 1 ? 's' : ''}</div>
      </div>`)
  }

  // One row per nil / blind nil bidder
  for (const seat of nilBidders) {
    const bid = summary.bids[seat]
    const tricks = summary.tricksWon[seat]
    const made = tricks === 0
    const nilPoints = bid === 'blind_nil' ? 100 : 50
    const nilScore = made ? `+${nilPoints}` : `-${nilPoints}`
    rows.push(`
      <div class="summary-nil-row">
        <span class="summary-nil-name">${esc(capitalize(seat))}</span>
        <span class="summary-nil-bid">${esc(bidLabel(bid))}</span>
        <span class="summary-nil-result ${made ? 'summary-nil-made' : 'summary-nil-failed'}">${made ? 'Made' : 'Failed'}</span>
        <span class="summary-nil-score ${made ? 'summary-score-pos' : 'summary-score-neg'}">${esc(nilScore)}</span>
      </div>`)
  }

  // Bag penalty row — only shown when a penalty was applied this hand
  if (summary.bagPenalty[team] < 0) {
    rows.push(`
      <div class="summary-penalty-row">
        <span class="summary-penalty-label">Bag Penalty</span>
        <span class="summary-score-neg">${summary.bagPenalty[team]}</span>
      </div>`)
  }

  // Running total after this hand
  rows.push(`
    <div class="summary-total">
      <span class="summary-total-score">${summary.scoresAfter[team]}</span>
      <span class="summary-total-bags">${summary.bagsAfter[team]} bag${summary.bagsAfter[team] !== 1 ? 's' : ''}</span>
    </div>`)

  return `
    <div class="summary-col ${isUs ? 'summary-col-us' : 'summary-col-them'}">
      <h4 class="summary-col-header">${isUs ? 'Us' : 'Them'}</h4>
      ${rows.join('')}
    </div>`
}

/**
 * Render the end-of-hand summary screen HTML.
 *
 * Shows two columns (Us / Them) with bid, tricks, score, and bag info for
 * each team. Nil and Blind Nil bidders get their own row. When both players
 * on a team bid nil (double nil) the shared team row is omitted.
 *
 * @param {object} summary - The handSummary object from game state
 * @param {string} mySeat - The viewing player's seat ('north'|'east'|'south'|'west')
 * @returns {string} HTML string
 */
export function endOfHandSummaryHtml(summary, mySeat) {
  const myTeam = TEAM_FOR_SEAT[mySeat]
  const theirTeam = myTeam === 'ns' ? 'ew' : 'ns'

  const usHtml = renderTeamColumn(summary, myTeam, true)
  const themHtml = renderTeamColumn(summary, theirTeam, false)

  return `
    <div class="hand-summary">
      <h3 class="summary-title">Hand ${esc(String(summary.handNumber))} Summary</h3>
      <div class="summary-columns">
        ${usHtml}
        ${themHtml}
      </div>
      <button class="btn-primary summary-continue-btn" id="summary-continue-btn">Continue</button>
    </div>`
}
