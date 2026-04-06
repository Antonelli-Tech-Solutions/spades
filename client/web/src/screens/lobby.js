import { navigate } from '../router.js'
import { logoutUser, listTables } from '../api.js'
import { redirectIfSeated } from '../redirectIfSeated.js'
import { createLobbySocket, buildWsUrl } from '../gameSocket.js'

/**
 * Apply a single lobby WebSocket event to a table map.
 * Mutates and returns the same object for easy chaining.
 *
 * Handles TABLE_CREATED, TABLE_UPDATED, TABLE_REMOVED.
 * Unknown event types are silently ignored.
 *
 * @param {object} tables - Map of tableId -> table data
 * @param {{ type: string, payload: object }} event
 * @returns {object} The updated table map
 */
export function applyLobbyEvent(tables, { type, payload }) {
  if (type === 'TABLE_CREATED') {
    tables[payload.tableId] = payload
  } else if (type === 'TABLE_UPDATED') {
    if (tables[payload.tableId]) {
      tables[payload.tableId] = { ...tables[payload.tableId], ...payload }
    }
  } else if (type === 'TABLE_REMOVED') {
    delete tables[payload.tableId]
  }
  return tables
}

/**
 * Render the lobby screen into `container`.
 * This is the main menu after login — from here players can create or join a table.
 * If the player is currently seated at an active table, redirect them back to it.
 * Subscribes to the WebSocket lobby channel for real-time table updates.
 * @param {HTMLElement} container
 */
export async function renderLobbyScreen(container) {
  const sessionId = sessionStorage.getItem('sessionId')
  const playerId = sessionStorage.getItem('playerId')
  if (!sessionId || !playerId) { navigate('#/login'); return }

  if (await redirectIfSeated(sessionId, playerId)) return

  const username = sessionStorage.getItem('username') || 'Player'

  container.innerHTML = `
    <div class="auth-card">
      <h1 class="auth-title">Lobby</h1>
      <p class="auth-message">Welcome back, <strong>${escapeHtml(username)}</strong>!</p>
      <div class="lobby-tables">
        <h2 class="lobby-tables-title">Open Tables</h2>
        <div id="table-list" class="table-list table-list-scroll">
          <p class="table-list-empty">Loading tables\u2026</p>
        </div>
      </div>
      <div class="lobby-actions">
        <button id="create-table-btn" class="btn-primary">Create Table</button>
        <button id="logout-btn" class="btn-link">Log out</button>
      </div>
    </div>
  `

  container.querySelector('#create-table-btn').addEventListener('click', () => {
    navigate('#/create-table')
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
    sessionStorage.removeItem('currentTableId')
    navigate('#/login')
  })

  // Table state: tableId -> table data
  let tables = {}

  function renderTableList() {
    const listEl = container.querySelector('#table-list')
    if (!listEl) return
    const tableArr = Object.values(tables)
    if (tableArr.length === 0) {
      listEl.innerHTML = '<p class="table-list-empty">No open tables. Create one to get started!</p>'
      return
    }
    listEl.innerHTML = tableArr.map(tableRowHtml).join('')

    listEl.querySelectorAll('.join-seat-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigate(`#/join?tableId=${encodeURIComponent(btn.dataset.tableId)}`)
      })
    })
  }

  // Fetch initial table list
  try {
    const { tables: initialTables } = await listTables({ sessionId, playerId })
    tables = {}
    for (const t of initialTables) {
      tables[t.tableId] = t
    }
  } catch (err) {
    if (err.status === 401) { navigate('#/login'); return }
    console.log('Failed to load tables:', { error: err.message })
  }
  renderTableList()

  // Subscribe to the lobby WebSocket channel for real-time updates
  const lobbySocket = createLobbySocket({
    wsUrl: buildWsUrl(sessionId),
    onOpen: async () => {
      console.log('Lobby WebSocket connected')
      // Re-sync table list now that the WebSocket is subscribed, to close the race window
      // between the initial fetch and when JOIN_LOBBY is acknowledged by the server.
      try {
        const { tables: freshTables } = await listTables({ sessionId, playerId })
        tables = {}
        for (const t of freshTables) {
          tables[t.tableId] = t
        }
        renderTableList()
      } catch (err) {
        console.log('Failed to sync tables on WebSocket connect:', { error: err.message })
      }
    },
    onEvent: (event) => {
      console.log('Lobby event:', { type: event.type, tableId: event.payload?.tableId })
      applyLobbyEvent(tables, event)
      renderTableList()
    },
    onClose: () => {
      console.log('Lobby WebSocket closed')
    },
    onError: (err) => {
      console.log('Lobby WebSocket error:', { error: err.message })
    },
  })

  // Unsubscribe when the lobby screen is navigated away from
  window.addEventListener('hashchange', () => {
    lobbySocket.close()
  }, { once: true })
}

function tableRowHtml(table) {
  const name = escapeHtml(table.name) || '<em>Unnamed Table</em>'
  const seats = table.seats || {}
  const occupied = Object.values(seats).filter((v) => v !== null).length
  const available = 4 - occupied
  const disabled = available === 0 ? ' disabled' : ''
  return `
    <div class="table-row" data-table-id="${escapeHtml(table.tableId)}">
      <div class="table-row-info">
        <span class="table-row-name">${name}</span>
        <span class="table-row-seats">${occupied}/4 seats filled</span>
      </div>
      <button class="btn-secondary join-seat-btn" data-table-id="${escapeHtml(table.tableId)}"${disabled}>Join</button>
    </div>
  `
}

function escapeHtml(str) {
  return str
    ? String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
    : ''
}
