import { listTables, sitAtTable } from '../api.js'
import { navigate } from '../router.js'
import { redirectIfSeated } from '../redirectIfSeated.js'

/**
 * Render the join table screen into `container`.
 *
 * If `?tableId=<id>` is in the URL query string, shows the seat picker for
 * that specific table directly (used after creating a table). Otherwise
 * shows a browsable list of all open (waiting) tables.
 *
 * After sitting, navigates to #/table?tableId=<id> (the game screen).
 *
 * @param {HTMLElement} container
 */
export async function renderJoinTableScreen(container) {
  const sessionId = sessionStorage.getItem('sessionId')
  const playerId = sessionStorage.getItem('playerId')
  if (!sessionId || !playerId) {
    navigate('#/login')
    return
  }

  if (await redirectIfSeated(sessionId, playerId)) return

  const params = new URLSearchParams(window.location.hash.split('?')[1] || '')
  const tableId = params.get('tableId')

  if (tableId) {
    renderSeatPicker(container, tableId, sessionId, playerId)
  } else {
    renderTableList(container, sessionId, playerId)
  }
}

function escapeHtml(str) {
  if (!str) return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function renderTableList(container, sessionId, playerId) {
  container.innerHTML = `
    <div class="auth-card join-table-card">
      <h1 class="auth-title">Join a Table</h1>
      <p class="join-loading">Loading tables\u2026</p>
    </div>
  `

  let tables
  try {
    const data = await listTables({ sessionId, playerId })
    tables = data.tables
  } catch (err) {
    if (err.status === 401) {
      navigate('#/login')
      return
    }
    container.querySelector('.join-loading').textContent = 'Failed to load tables. Please try again.'
    return
  }

  const card = container.querySelector('.join-table-card')

  if (tables.length === 0) {
    card.innerHTML = `
      <h1 class="auth-title">Join a Table</h1>
      <p class="auth-message">No open tables right now.</p>
      <div class="lobby-actions">
        <button id="create-table-btn" class="btn-primary">Create a Table</button>
        <button id="refresh-btn" class="btn-secondary">Refresh</button>
      </div>
      <p class="auth-link"><a href="#/lobby">Back to lobby</a></p>
    `
    card.querySelector('#create-table-btn').addEventListener('click', () => navigate('#/create-table'))
    card.querySelector('#refresh-btn').addEventListener('click', () => renderTableList(container, sessionId, playerId))
    return
  }

  const rows = tables.map((t) => {
    const name = escapeHtml(t.name) || '<em>Unnamed Table</em>'
    const occupied = 4 - t.seatsAvailable
    return `
      <div class="table-row" data-table-id="${escapeHtml(t.tableId)}">
        <div class="table-row-info">
          <span class="table-row-name">${name}</span>
          <span class="table-row-seats">${occupied}/4 seats filled</span>
        </div>
        <button class="btn-secondary join-seat-btn" data-table-id="${escapeHtml(t.tableId)}">Join</button>
      </div>
    `
  }).join('')

  card.innerHTML = `
    <h1 class="auth-title">Join a Table</h1>
    <div class="table-list">${rows}</div>
    <div class="lobby-actions" style="margin-top: 1rem;">
      <button id="refresh-btn" class="btn-secondary">Refresh</button>
      <button id="create-table-btn" class="btn-secondary">Create a Table</button>
    </div>
    <p class="auth-link"><a href="#/lobby">Back to lobby</a></p>
  `

  card.querySelectorAll('.join-seat-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tid = btn.dataset.tableId
      navigate(`#/join?tableId=${tid}`)
    })
  })
  card.querySelector('#refresh-btn').addEventListener('click', () => renderTableList(container, sessionId, playerId))
  card.querySelector('#create-table-btn').addEventListener('click', () => navigate('#/create-table'))
}

async function renderSeatPicker(container, tableId, sessionId, playerId) {
  container.innerHTML = `
    <div class="auth-card join-table-card">
      <h1 class="auth-title">Choose a Seat</h1>
      <p class="join-loading">Loading table\u2026</p>
    </div>
  `

  // Fetch table state to see which seats are taken
  let seats
  try {
    const res = await fetch(`/api/tables/${tableId}/state`, {
      headers: { 'x-session-id': sessionId, 'x-player-id': playerId },
    })
    if (res.status === 401) { navigate('#/login'); return }
    if (res.status === 404) {
      container.querySelector('.join-loading').textContent = 'Table not found.'
      return
    }
    if (res.ok) {
      const data = await res.json()
      seats = data.seats
    }
  } catch (_) {
    // If we can't fetch state (player not seated yet), get from list
  }

  // If we couldn't get seats from state (player not seated), try the list endpoint
  if (!seats) {
    try {
      const listData = await listTables({ sessionId, playerId })
      const found = listData.tables.find((t) => t.tableId === tableId)
      seats = found ? found.seats : { north: null, east: null, south: null, west: null }
    } catch (_) {
      seats = { north: null, east: null, south: null, west: null }
    }
  }

  const card = container.querySelector('.join-table-card')
  const errorId = 'seat-error'

  card.innerHTML = `
    <h1 class="auth-title">Choose a Seat</h1>
    <p class="auth-message">Select an available seat to join the table.</p>
    <div class="seat-grid">
      ${renderSeatButton('north', seats.north)}
      <div class="seat-row-middle">
        ${renderSeatButton('west', seats.west)}
        <div class="seat-center">
          <span class="seat-center-label">Table</span>
        </div>
        ${renderSeatButton('east', seats.east)}
      </div>
      ${renderSeatButton('south', seats.south)}
    </div>
    <div class="form-error" id="${errorId}" role="alert" aria-live="polite"></div>
    <p class="auth-link"><a href="#/join">Back to table list</a></p>
  `

  const errorEl = card.querySelector(`#${errorId}`)

  card.querySelectorAll('.seat-btn:not(:disabled)').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const seat = btn.dataset.seat
      errorEl.textContent = ''
      card.querySelectorAll('.seat-btn').forEach((b) => { b.disabled = true })
      btn.textContent = 'Joining\u2026'

      try {
        await sitAtTable({ tableId, seat, sessionId, playerId })
        sessionStorage.setItem('currentTableId', tableId)
        console.log('Seated:', { tableId, seat })
        navigate(`#/table?tableId=${tableId}`)
      } catch (err) {
        if (err.status === 401) { navigate('#/login'); return }
        errorEl.textContent = err.message || 'Failed to sit at this seat.'
        // Re-enable buttons except the one that's now taken
        card.querySelectorAll('.seat-btn').forEach((b) => {
          if (b.dataset.seat !== seat) b.disabled = false
        })
        btn.textContent = seatLabel(seat)
      }
    })
  })
}

function renderSeatButton(seat, occupant) {
  const label = seatLabel(seat)
  const taken = occupant !== null
  const disabled = taken ? 'disabled' : ''
  const cls = taken ? 'seat-btn seat-btn--taken' : 'seat-btn seat-btn--available'
  let text = label
  if (taken) {
    if (occupant && typeof occupant === 'object') {
      text = occupant.isBot ? 'Bot' : escapeHtml(occupant.username ?? 'Taken')
    } else {
      text = 'Taken'
    }
  }
  return `<button class="${cls}" data-seat="${seat}" ${disabled}>${text}</button>`
}

function seatLabel(seat) {
  return seat.charAt(0).toUpperCase() + seat.slice(1)
}
