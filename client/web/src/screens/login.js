import { validateLoginForm } from '../validation.js'
import { loginUser } from '../api.js'
import { navigate } from '../router.js'

/**
 * Render the login screen into `container`.
 * On success, stores session data in sessionStorage and navigates to #/lobby.
 * @param {HTMLElement} container
 */
export function renderLoginScreen(container) {
  container.innerHTML = `
    <div class="auth-card">
      <h1 class="auth-title">Sign In</h1>
      <form id="login-form" novalidate>
        <div class="form-group">
          <label for="login-email">Email</label>
          <input
            type="email"
            id="login-email"
            name="email"
            autocomplete="email"
            placeholder="you@example.com"
          />
        </div>
        <div class="form-group">
          <label for="login-password">Password</label>
          <input
            type="password"
            id="login-password"
            name="password"
            autocomplete="current-password"
            placeholder="Your password"
          />
        </div>
        <div class="form-error" id="login-error" role="alert" aria-live="polite"></div>
        <button type="submit" id="login-btn" class="btn-primary">Sign In</button>
      </form>
      <p class="auth-link">Don't have an account? <a href="#/register">Create one</a></p>
    </div>
  `

  const form = container.querySelector('#login-form')
  const errorEl = container.querySelector('#login-error')
  const btn = container.querySelector('#login-btn')

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    errorEl.textContent = ''

    const email = form.querySelector('#login-email').value.trim()
    const password = form.querySelector('#login-password').value

    const validationError = validateLoginForm({ email, password })
    if (validationError) {
      errorEl.textContent = validationError
      return
    }

    btn.disabled = true
    btn.textContent = 'Signing in\u2026'

    try {
      const { sessionId, playerId, username } = await loginUser({ email, password })
      sessionStorage.setItem('sessionId', sessionId)
      sessionStorage.setItem('playerId', playerId)
      sessionStorage.setItem('username', username)
      console.log('Login successful:', { playerId, username })
      navigate('#/lobby')
    } catch (err) {
      let message = err.message
      if (err.status === 401) message = 'Invalid email or password.'
      if (err.status === 403) message = 'Please verify your email address before signing in.'
      errorEl.textContent = message
      btn.disabled = false
      btn.textContent = 'Sign In'
    }
  })
}
