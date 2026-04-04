import { validateRegisterForm } from '../validation.js'
import { registerUser, resendVerification } from '../api.js'
import { navigate } from '../router.js'

/**
 * Render the registration screen into `container`.
 * On success, replaces the form with a "check your email" confirmation.
 * @param {HTMLElement} container
 */
export function renderRegisterScreen(container) {
  container.innerHTML = `
    <div class="auth-card">
      <h1 class="auth-title">Create Account</h1>
      <form id="register-form" novalidate>
        <div class="form-group">
          <label for="reg-email">Email</label>
          <input
            type="email"
            id="reg-email"
            name="email"
            autocomplete="email"
            placeholder="you@example.com"
          />
        </div>
        <div class="form-group">
          <label for="reg-username">Username</label>
          <input
            type="text"
            id="reg-username"
            name="username"
            autocomplete="username"
            placeholder="Choose a username"
          />
        </div>
        <div class="form-group">
          <label for="reg-password">Password</label>
          <input
            type="password"
            id="reg-password"
            name="password"
            autocomplete="new-password"
            placeholder="At least 8 characters"
          />
        </div>
        <div class="form-error" id="register-error" role="alert" aria-live="polite"></div>
        <button type="submit" id="register-btn" class="btn-primary">Create Account</button>
      </form>
      <p class="auth-link">Already have an account? <a href="#/login">Sign in</a></p>
    </div>
  `

  const form = container.querySelector('#register-form')
  const errorEl = container.querySelector('#register-error')
  const btn = container.querySelector('#register-btn')

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    errorEl.textContent = ''

    const email = form.querySelector('#reg-email').value.trim()
    const username = form.querySelector('#reg-username').value.trim()
    const password = form.querySelector('#reg-password').value

    const validationError = validateRegisterForm({ email, username, password })
    if (validationError) {
      errorEl.textContent = validationError
      return
    }

    btn.disabled = true
    btn.textContent = 'Creating account\u2026'

    try {
      const result = await registerUser({ email, username, password })

      if (result.sessionId) {
        sessionStorage.setItem('sessionId', result.sessionId)
        sessionStorage.setItem('playerId', result.playerId)
        sessionStorage.setItem('username', result.username)
        console.log('Auto-verified registration, going to lobby:', { playerId: result.playerId, username: result.username })
        navigate('#/lobby')
        return
      }

      const safeEmail = escapeHtml(email)
      container.innerHTML = `
        <div class="auth-card">
          <h1 class="auth-title">Check your email</h1>
          <p class="auth-message">
            We've sent a verification link to <strong>${safeEmail}</strong>.
            Click the link in that email to activate your account, then sign in.
          </p>
          <p class="auth-message" id="resend-status">
            Didn't receive it?
            <button type="button" id="resend-btn" class="btn-link">Resend verification email</button>
          </p>
          <p class="auth-link"><a href="#/login">Back to sign in</a></p>
        </div>
      `
      container.querySelector('#resend-btn').addEventListener('click', async () => {
        const resendStatus = container.querySelector('#resend-status')
        resendStatus.textContent = 'Sending\u2026'
        try {
          await resendVerification({ email })
          resendStatus.textContent = 'Verification email resent — check your inbox.'
        } catch (_err) {
          resendStatus.textContent = 'Could not send email. Please try again later.'
        }
      })
    } catch (err) {
      errorEl.textContent = err.message
      btn.disabled = false
      btn.textContent = 'Create Account'
    }
  })
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
