import { getGameState } from '../api.js'
import { navigate } from '../router.js'

const TEAM = { north: 'ns', south: 'ns', east: 'ew', west: 'ew' }

function getSeatForPlayer(players, playerId) {
  return Object.entries(players).find(([, pid]) => pid === playerId)?.[0] ?? null
}

/**
 * Render the game over screen into `container`.
 * Fetches the final game state and displays the result.
 *
 * @param {HTMLElement} container
 */
export function renderGameOverScreen(container) {
  const sessionId = sessionStorage.getItem('sessionId')
  const playerId = sessionStorage.getItem('playerId')
  if (!sessionId || !playerId) { navigate('#/login'); return }

  const params = new URLSearchParams(window.location.hash.split('?')[1] || '')
  const tableId = params.get('tableId')
  if (!tableId) { navigate('#/lobby'); return }

  container.innerHTML = `
    <div class="auth-card">
      <h1 class="auth-title">Game Over</h1>
      <p class="auth-message">Loading results\u2026</p>
    </div>`

  getGameState({ tableId, sessionId, playerId }).then((state) => {
    const mySeat = getSeatForPlayer(state.players, playerId)
    const myTeam = mySeat ? TEAM[mySeat] : null
    const winner = state.winner
    const iWon = myTeam && winner === myTeam

    const nsScore = state.scores.ns
    const ewScore = state.scores.ew
    const nsBags = state.bags.ns
    const ewBags = state.bags.ew

    const winnerLabel = winner === 'ns' ? 'North / South' : 'East / West'
    const resultMsg = iWon ? 'Your team wins!' : (myTeam ? 'Your team loses.' : `${winnerLabel} wins!`)

    container.innerHTML = `
      <div class="auth-card game-over-card">
        <h1 class="auth-title">Game Over</h1>
        <p class="auth-message">${resultMsg}</p>

        <div class="game-over-scores">
          <div class="game-over-team${winner === 'ns' ? ' game-over-winner' : ''}">
            <span class="game-over-team-label">N/S</span>
            <span class="game-over-pts">${nsScore}</span>
            <span class="game-over-bags">${nsBags} bag${nsBags !== 1 ? 's' : ''}</span>
            ${winner === 'ns' ? '<span class="game-over-crown">Winner</span>' : ''}
          </div>
          <div class="game-over-vs">vs</div>
          <div class="game-over-team${winner === 'ew' ? ' game-over-winner' : ''}">
            <span class="game-over-team-label">E/W</span>
            <span class="game-over-pts">${ewScore}</span>
            <span class="game-over-bags">${ewBags} bag${ewBags !== 1 ? 's' : ''}</span>
            ${winner === 'ew' ? '<span class="game-over-crown">Winner</span>' : ''}
          </div>
        </div>

        <div class="lobby-actions" style="margin-top: 1.5rem;">
          <button id="lobby-btn" class="btn-primary">Back to Lobby</button>
        </div>
      </div>`

    container.querySelector('#lobby-btn').addEventListener('click', () => navigate('#/lobby'))
  }).catch((err) => {
    if (err.status === 401) { navigate('#/login'); return }

    container.innerHTML = `
      <div class="auth-card">
        <h1 class="auth-title">Game Over</h1>
        <p class="auth-message">Failed to load results.</p>
        <div class="lobby-actions" style="margin-top: 1rem;">
          <button id="lobby-btn" class="btn-primary">Back to Lobby</button>
        </div>
      </div>`
    container.querySelector('#lobby-btn').addEventListener('click', () => navigate('#/lobby'))
  })
}
