/**
 * End-of-hand summary overlay component.
 *
 * Renders a two-column summary (Us | Them) for the most recently completed hand.
 * Each column shows:
 *   - Team total row: bid, tricks taken, score delta, bags earned
 *     (omitted when both players on the team bid nil — double nil)
 *   - One row per nil / blind nil bidder on that team
 *   - A bag penalty notice if 10+ bags were crossed this hand
 *   - Running totals: score and bags after this hand
 *
 * The caller renders this as an overlay and wires up the Continue button.
 */

const TEAM = { north: 'ns', south: 'ns', east: 'ew', west: 'ew' }
const TEAM_SEATS = { ns: ['north', 'south'], ew: ['east', 'west'] }
const TEAM_LABEL = { ns: 'N/S', ew: 'E/W' }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render individual rows for nil and blind nil bidders on a team.
 */
function nilBidderRowsHtml(team, entry) {
  const rows = []
  for (const seat of TEAM_SEATS[team]) {
    const bid = entry.bids[seat]
    if (bid !== 'nil' && bid !== 'blind_nil') continue

    const points = bid === 'blind_nil' ? 100 : 50
    const made = entry.tricksWon[seat] === 0
    const label = bid === 'blind_nil' ? 'Blind Nil' : 'Nil'
    const name = seat.charAt(0).toUpperCase() + seat.slice(1)
    const resultClass = made ? 'nil-made' : 'nil-failed'
    const resultText = made ? `Made \u2713 +${points}` : `Failed \u2717 \u2212${points}`

    rows.push(`
      <div class="summary-row nil-row ${resultClass}">
        <span class="summary-row-label">${esc(name)} ${esc(label)}</span>
        <span class="summary-row-value">${resultText}</span>
      </div>`)
  }
  return rows.join('')
}

/**
 * Render the column for one team.
 */
function teamColHtml(team, entry, colLabel) {
  const seats = TEAM_SEATS[team]
  const nilBidders = seats.filter((s) => entry.bids[s] === 'nil' || entry.bids[s] === 'blind_nil')
  const isDoubleNil = nilBidders.length === 2

  let teamRowHtml = ''
  if (!isDoubleNil) {
    const teamBid = entry.teamBids[team]
    const teamTricks = seats.reduce((sum, s) => sum + entry.tricksWon[s], 0)
    const delta = entry.scoreDelta[team]
    const sign = delta >= 0 ? '+' : ''
    const bagsEarned = entry.newBags[team]
    const bagsText = bagsEarned > 0 ? `, +${bagsEarned} bag${bagsEarned !== 1 ? 's' : ''}` : ''
    teamRowHtml = `
      <div class="summary-row team-row">
        <span class="summary-row-label">Bid ${esc(String(teamBid))}, Took ${teamTricks}</span>
        <span class="summary-row-value">${sign}${delta} pts${esc(bagsText)}</span>
      </div>`
  }

  const nilRows = nilBidderRowsHtml(team, entry)

  let penaltyHtml = ''
  if (entry.bagPenalty[team] > 0) {
    const penaltyPts = entry.bagPenalty[team] * 100
    penaltyHtml = `
      <div class="summary-row penalty-row">
        <span class="summary-row-label">Bag penalty${entry.bagPenalty[team] > 1 ? ` \u00d7${entry.bagPenalty[team]}` : ''}</span>
        <span class="summary-row-value">\u2212${penaltyPts} pts</span>
      </div>`
  }

  const scoreAfter = entry.scoresAfter[team]
  const bagsAfter = entry.bagsAfter[team]

  return `
    <div class="hand-summary-col">
      <h4 class="summary-col-title">${esc(colLabel)}</h4>
      ${teamRowHtml}
      ${nilRows}
      ${penaltyHtml}
      <div class="summary-total">
        <span class="summary-score">${scoreAfter} pts</span>
        <span class="summary-bags">${bagsAfter} bag${bagsAfter !== 1 ? 's' : ''}</span>
      </div>
    </div>`
}

/**
 * Render the end-of-hand summary overlay HTML.
 *
 * @param {object} entry - A hand history entry from state.handHistory
 * @param {string} mySeat - The viewing player's seat ('north'|'east'|'south'|'west')
 * @returns {string} HTML string for the overlay
 */
export function endOfHandSummaryHtml(entry, mySeat) {
  const myTeam = TEAM[mySeat]
  const theirTeam = myTeam === 'ns' ? 'ew' : 'ns'

  const usLabel = `Us (${TEAM_LABEL[myTeam]})`
  const themLabel = `Them (${TEAM_LABEL[theirTeam]})`

  const scoresBefore = entry.scoresBefore || { ns: 0, ew: 0 }
  const myScoreBefore = scoresBefore[myTeam]
  const theirScoreBefore = scoresBefore[theirTeam]

  return `
    <div class="hand-summary-overlay" id="hand-summary-overlay">
      <div class="hand-summary-modal" role="dialog" aria-label="Hand ${esc(String(entry.handNumber))} Summary">
        <h3 class="hand-summary-title">Hand ${esc(String(entry.handNumber))} Summary</h3>
        <div class="hand-summary-scores-before">
          <div class="scores-before-team">
            <span class="scores-before-label">${esc(usLabel)}</span>
            <span class="scores-before-value">${myScoreBefore}</span>
          </div>
          <div class="scores-before-sep">vs</div>
          <div class="scores-before-team">
            <span class="scores-before-label">${esc(themLabel)}</span>
            <span class="scores-before-value">${theirScoreBefore}</span>
          </div>
        </div>
        <div class="hand-summary-cols">
          ${teamColHtml(myTeam, entry, usLabel)}
          ${teamColHtml(theirTeam, entry, themLabel)}
        </div>
        <button class="btn-primary hand-summary-continue" id="hand-summary-continue">Continue</button>
      </div>
    </div>`
}
