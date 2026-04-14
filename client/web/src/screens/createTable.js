import { createTable } from '../api.js'
import { navigate } from '../router.js'
import { redirectIfSeated } from '../redirectIfSeated.js'

const JOIN_POLICIES_BY_VISIBILITY = {
  'public': ['open', 'friends-only', 'invite-only'],
  'friends-only': ['friends-only', 'invite-only'],
  'private': ['invite-only'],
}

const JOIN_POLICY_LABELS = {
  'open': 'Open',
  'friends-only': 'Friends Only',
  'invite-only': 'Invite Only',
}

function buildJoinPolicyOptions(visibility) {
  return JOIN_POLICIES_BY_VISIBILITY[visibility] || ['open']
}

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
        <div class="form-group">
          <label for="table-visibility">Visibility</label>
          <select id="table-visibility" name="visibility">
            <option value="public" selected>Public</option>
            <option value="friends-only">Friends Only</option>
            <option value="private">Private</option>
          </select>
        </div>
        <div class="form-group" id="join-policy-group">
          <label for="table-join-policy">Join Policy</label>
          <select id="table-join-policy" name="joinPolicy">
            <option value="open" selected>Open</option>
            <option value="friends-only">Friends Only</option>
            <option value="invite-only">Invite Only</option>
          </select>
        </div>
        <div class="form-group">
          <label for="table-spectating">
            <input type="checkbox" id="table-spectating" name="spectating" checked />
            Allow Spectators
          </label>
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
  const visibilitySelect = container.querySelector('#table-visibility')
  const joinPolicySelect = container.querySelector('#table-join-policy')
  const joinPolicyGroup = container.querySelector('#join-policy-group')

  function updateJoinPolicyOptions() {
    const vis = visibilitySelect.value
    const allowed = buildJoinPolicyOptions(vis)
    joinPolicySelect.innerHTML = allowed
      .map((p) => `<option value="${p}">${JOIN_POLICY_LABELS[p]}</option>`)
      .join('')
    if (allowed.length <= 1) {
      joinPolicyGroup.style.display = 'none'
    } else {
      joinPolicyGroup.style.display = ''
    }
  }

  visibilitySelect.addEventListener('change', updateJoinPolicyOptions)
  updateJoinPolicyOptions()

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

    const visibility = visibilitySelect.value
    const joinPolicy = joinPolicySelect.value
    const spectating = container.querySelector('#table-spectating').checked

    btn.disabled = true
    btn.textContent = 'Creating\u2026'

    try {
      const { tableId } = await createTable({
        name: name || null,
        visibility,
        joinPolicy,
        spectating,
        sessionId,
        playerId,
      })
      console.log('Table created:', { tableId, name: name || null, visibility, joinPolicy, spectating })
      sessionStorage.setItem('currentTableId', tableId)
      navigate(`#/table?tableId=${tableId}`)
    } catch (err) {
      errorEl.textContent = err.message
      btn.disabled = false
      btn.textContent = 'Create Table'
    }
  })
}
