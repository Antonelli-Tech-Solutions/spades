import { createTable } from '../api.js'
import { navigate } from '../router.js'
import { redirectIfSeated } from '../redirectIfSeated.js'

/**
 * Render the create table screen into `container`.
 * On success, navigates to the join table screen (#/join) for the new table.
 * Name is optional — the PRD specifies it is displayed in the public lobby browser
 * but is not required.
 * If the player is currently seated at an active table, redirect them back to it.
 * @param {HTMLElement} container
 */
export async function renderCreateTableScreen(container) {
  const sessionId = sessionStorage.getItem('sessionId')
  const playerId = sessionStorage.getItem('playerId')
  if (!sessionId || !playerId) { navigate('#/login'); return }

  if (await redirectIfSeated(sessionId, playerId)) return

  container.innerHTML = `
    <div class="auth-card">
      <h1 class="auth-title">Create Table</h1>
      <form id="create-table-form" novalidate>
        <div class="form-group">
          <label for="table-name">Table Name <span class="field-optional">(optional)</span></label>
          <input
            type="text"
            id="table-name"
            name="name"
            maxlength="50"
            autocomplete="off"
            placeholder="e.g. Friday Night Spades"
          />
        </div>
        <div class="form-error" id="create-table-error" role="alert" aria-live="polite"></div>
        <button type="submit" id="create-table-btn" class="btn-primary">Create Table</button>
      </form>
      <p class="auth-link"><a href="#/lobby">Back to lobby</a></p>
    </div>
  `

  const form = container.querySelector('#create-table-form')
  const errorEl = container.querySelector('#create-table-error')
  const btn = container.querySelector('#create-table-btn')

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    errorEl.textContent = ''

    const name = form.querySelector('#table-name').value.trim()
    if (name.length > 50) {
      errorEl.textContent = 'Table name must be 50 characters or fewer.'
      return
    }

    const sessionId = sessionStorage.getItem('sessionId')
    const playerId = sessionStorage.getItem('playerId')
    if (!sessionId || !playerId) {
      navigate('#/login')
      return
    }

    btn.disabled = true
    btn.textContent = 'Creating\u2026'

    try {
      const { tableId } = await createTable({ name: name || null, sessionId, playerId })
      console.log('Table created:', { tableId, name: name || null })
      sessionStorage.setItem('currentTableId', tableId)
      navigate(`#/table?tableId=${tableId}`)
    } catch (err) {
      errorEl.textContent = err.message
      btn.disabled = false
      btn.textContent = 'Create Table'
    }
  })
}
