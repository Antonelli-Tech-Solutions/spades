import { forgotPassword } from '../api.js'
import { navigate } from '../router.js'

/**
 * Render the forgot password screen into `container`.
 * On submit, sends a reset email (or silently succeeds if email not found).
 * @param {HTMLElement} container
 */
export function renderForgotPasswordScreen(container) {
  container.innerHTML = `
    <div class="auth-card">
      <h1 class="auth-title">Forgot Password</h1>
      <p class="auth-message">Enter your email address and we'll send you a link to reset your password.</p>
      <form id="forgot-form" novalidate>
        <div class="form-group">
          <label for="forgot-email">Email</label>
          <input
            type="email"
            id="forgot-email"
            name="email"
            autocomplete="email"
            placeholder="you@example.com"
          />
        </div>
        <div class="form-error" id="forgot-error" role="alert" aria-live="polite"></div>
        <button type="submit" id="forgot-btn" class="btn-primary">Send Reset Link</button>
      </form>
      <p class="auth-link"><a href="#/login">Back to sign in</a></p>
    </div>
  `

  const form = container.querySelector('#forgot-form')
  const errorEl = container.querySelector('#forgot-error')
  const btn = container.querySelector('#forgot-btn')

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    errorEl.textContent = ''

    const email = form.querySelector('#forgot-email').value.trim()
    if (!email) {
      errorEl.textContent = 'Please enter your email address.'
      return
    }

    btn.disabled = true
    btn.textContent = 'Sending\u2026'

    try {
      await forgotPassword({ email })
      container.innerHTML = `
        <div class="auth-card">
          <h1 class="auth-title">Check your email</h1>
          <p class="auth-message">
            If <strong>${escapeHtml(email)}</strong> is registered, you'll receive a password reset link shortly.
            Check your spam folder if it doesn't arrive.
          </p>
          <p class="auth-link"><a href="#/login">Back to sign in</a></p>
        </div>
      `
    } catch (_err) {
      errorEl.textContent = 'Something went wrong. Please try again later.'
      btn.disabled = false
      btn.textContent = 'Send Reset Link'
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
