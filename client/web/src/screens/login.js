import { validateLoginForm } from '../validation.js'
import { loginUser, resendVerification } from '../api.js'
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
        <div id="login-resend-section" style="display:none;" class="auth-resend">
          <button type="button" id="resend-btn" class="btn-secondary">Resend verification email</button>
        </div>
        <button type="submit" id="login-btn" class="btn-primary">Sign In</button>
      </form>
      <p class="auth-link">Don't have an account? <a href="#/register">Create one</a></p>
      <p class="auth-link"><a href="#/forgot-password">Forgot your password?</a></p>
    </div>
  `

  const form = container.querySelector('#login-form')
  const errorEl = container.querySelector('#login-error')
  const btn = container.querySelector('#login-btn')
  const resendSection = container.querySelector('#login-resend-section')
  const resendBtn = container.querySelector('#resend-btn')

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    errorEl.textContent = ''
    resendSection.style.display = 'none'

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
      if (err.status === 403) {
        message = 'Please verify your email address before signing in.'
        resendSection.style.display = 'block'
      }
      errorEl.textContent = message
      btn.disabled = false
      btn.textContent = 'Sign In'
    }
  })

  resendBtn.addEventListener('click', async () => {
    const email = form.querySelector('#login-email').value.trim()
    resendBtn.disabled = true
    resendBtn.textContent = 'Sending\u2026'
    errorEl.textContent = ''

    try {
      await resendVerification({ email })
      resendSection.innerHTML = '<p class="auth-message">Verification email sent — check your inbox.</p>'
    } catch (_err) {
      resendSection.innerHTML = '<p class="auth-message">Could not send email. Please try again later.</p>'
    }
  })
}
