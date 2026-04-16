import { navigate } from '../router.js'
import { logoutUser, listLobbyTables } from '../api.js'
import { redirectIfSeated } from '../redirectIfSeated.js'
import { createLobbySocket, buildWsUrl } from '../gameSocket.js'
import { renderFriendsPanel } from '../friendsPanel.js'

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
        <div class="lobby-filters">
          <input
            type="text"
            id="lobby-search"
            class="lobby-search-input"
            placeholder="Search tables by name\u2026"
            autocomplete="off"
          />
          <label class="lobby-has-seats">
            <input type="checkbox" id="lobby-has-seats" />
            Open seats only
          </label>
        </div>
        <div id="table-list" class="table-list table-list-scroll">
          <p class="table-list-empty">Loading tables\u2026</p>
        </div>
      </div>
      <div id="friends-panel-mount"></div>
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
  // Filter state — applied client-side for live WS updates, sent to server on (re)sync
  const filters = { hasSeats: false, search: '' }

  function tableMatchesFilters(table) {
    if (filters.hasSeats) {
      const seatsAvailable = typeof table.seatsAvailable === 'number'
        ? table.seatsAvailable
        : Object.values(table.seats || {}).filter((v) => v === null).length
      if (seatsAvailable === 0) return false
    }
    const term = filters.search.trim().toLowerCase()
    if (term) {
      if (typeof table.name !== 'string') return false
      if (!table.name.toLowerCase().includes(term)) return false
    }
    return true
  }

  function renderTableList() {
    const listEl = container.querySelector('#table-list')
    if (!listEl) return
    const tableArr = Object.values(tables).filter(tableMatchesFilters)
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

  async function loadTables() {
    const { tables: fresh } = await listLobbyTables({
      sessionId,
      playerId,
      hasSeats: filters.hasSeats,
      search: filters.search,
    })
    tables = {}
    for (const t of fresh) {
      tables[t.tableId] = t
    }
  }

  // Fetch initial table list
  try {
    await loadTables()
  } catch (err) {
    if (err.status === 401) { navigate('#/login'); return }
    console.log('Failed to load tables:', { error: err.message })
  }
  renderTableList()

  // Re-sync the full table list and re-render. Called on initial connect and on reconnect
  // to close the race window between the initial fetch and when the server acks the join,
  // and to catch up on any events missed during a reconnect.
  async function syncTableList(label) {
    console.log(`Lobby WebSocket ${label}`)
    try {
      await loadTables()
      renderTableList()
    } catch (err) {
      console.log(`Failed to sync tables on WebSocket ${label}:`, { error: err.message })
    }
  }

  // Wire filter controls
  const searchEl = container.querySelector('#lobby-search')
  const hasSeatsEl = container.querySelector('#lobby-has-seats')
  let searchDebounce = null
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      filters.search = searchEl.value
      if (searchDebounce) clearTimeout(searchDebounce)
      searchDebounce = setTimeout(async () => {
        try { await loadTables() } catch (err) { console.log('Filter sync failed:', { error: err.message }) }
        renderTableList()
      }, 200)
    })
  }
  if (hasSeatsEl) {
    hasSeatsEl.addEventListener('change', async () => {
      filters.hasSeats = hasSeatsEl.checked
      try { await loadTables() } catch (err) { console.log('Filter sync failed:', { error: err.message }) }
      renderTableList()
    })
  }

  // Subscribe to the lobby WebSocket channel for real-time updates
  const lobbySocket = createLobbySocket({
    wsUrl: buildWsUrl(sessionId),
    onOpen: () => syncTableList('connected'),
    onReconnect: () => syncTableList('reconnected'),
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

  // Mount the friends panel with periodic polling
  const friendsMount = container.querySelector('#friends-panel-mount')
  const friendsPanel = friendsMount
    ? renderFriendsPanel({ mountEl: friendsMount, sessionId, playerId })
    : null

  // Unsubscribe when the lobby screen is navigated away from
  window.addEventListener('hashchange', () => {
    lobbySocket.close()
    if (friendsPanel) friendsPanel.stop()
  }, { once: true })
}

/**
 * Normalize a seat value to a consistent shape.
 * Handles both the enriched object format { playerId, username, isBot }
 * and the legacy raw string format (player ID or null).
 */
function normalizeSeat(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return v
  // Legacy string: either a human player ID or 'bot:<seat>'
  const isBot = v.startsWith('bot:')
  return { playerId: v, username: null, isBot }
}

function tableRowHtml(table) {
  const name = escapeHtml(table.name) || '<em>Unnamed Table</em>'
  const seats = table.seats || {}
  const normalized = Object.values(seats).map(normalizeSeat)
  const occupied = normalized.filter((v) => v !== null).length
  const botCount = normalized.filter((v) => v?.isBot).length
  const available = 4 - occupied
  const disabled = available === 0 ? ' disabled' : ''

  let seatsLabel = `${occupied}/4 seats filled`
  if (botCount > 0) {
    seatsLabel += ` (${botCount} bot${botCount !== 1 ? 's' : ''})`
  }

  const observerCount = table.observerCount || 0
  const spectatorLabel = observerCount > 0
    ? `<span class="table-row-spectators">${observerCount} spectator${observerCount !== 1 ? 's' : ''}</span>`
    : ''

  const occupantNames = normalized
    .filter((v) => v !== null && !v.isBot && v.username)
    .map((v) => escapeHtml(v.username))

  const occupantSummary = occupantNames.length > 0
    ? `<span class="table-row-players">${occupantNames.join(', ')}</span>`
    : ''

  return `
    <div class="table-row" data-table-id="${escapeHtml(table.tableId)}">
      <div class="table-row-info">
        <span class="table-row-name">${name}</span>
        <span class="table-row-seats">${seatsLabel}</span>
        ${spectatorLabel}
        ${occupantSummary}
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
