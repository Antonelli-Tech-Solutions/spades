import { navigate } from '../router.js'
import { logoutUser } from '../api.js'

/**
 * Render the lobby screen into `container`.
 * This is the main menu after login — from here players can create or join a table.
 * @param {HTMLElement} container
 */
export function renderLobbyScreen(container) {
  const username = sessionStorage.getItem('username') || 'Player'

  container.innerHTML = `
    <div class="auth-card">
      <h1 class="auth-title">Lobby</h1>
      <p class="auth-message">Welcome back, <strong>${escapeHtml(username)}</strong>!</p>
      <div class="lobby-actions">
        <button id="create-table-btn" class="btn-primary">Create Table</button>
        <button id="join-table-btn" class="btn-secondary">Join Table</button>
        <button id="logout-btn" class="btn-link">Log out</button>
      </div>
    </div>
  `

  container.querySelector('#create-table-btn').addEventListener('click', () => {
    navigate('#/create-table')
  })

  container.querySelector('#join-table-btn').addEventListener('click', () => {
    navigate('#/join')
  })

  container.querySelector('#logout-btn').addEventListener('click', async () => {
    const sessionId = sessionStorage.getItem('sessionId')
    try {
      await logoutUser({ sessionId })
    } catch (err) {
      console.log('Logout error (proceeding anyway):', { error: err.message })
    }
    sessionStorage.removeItem('sessionId')
    sessionStorage.removeItem('playerId')
    sessionStorage.removeItem('username')
    navigate('#/login')
  })
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
