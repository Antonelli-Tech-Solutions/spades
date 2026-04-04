import { resetPassword } from '../api.js'
import { navigate } from '../router.js'

/**
 * Extract the reset token from the hash query string.
 * e.g. window.location.hash = '#/reset-password?token=abc123' → 'abc123'
 * @returns {string|null}
 */
function getTokenFromHash() {
  const hash = window.location.hash || ''
  const queryIndex = hash.indexOf('?')
  if (queryIndex === -1) return null
  const params = new URLSearchParams(hash.slice(queryIndex + 1))
  return params.get('token')
}

/**
 * Render the reset password screen into `container`.
 * Reads the token from the URL hash, shows a new password form.
 * @param {HTMLElement} container
 */
export function renderResetPasswordScreen(container) {
  const token = getTokenFromHash()

  if (!token) {
    container.innerHTML = `
      <div class="auth-card">
        <h1 class="auth-title">Invalid Link</h1>
        <p class="auth-message">This password reset link is invalid. Please request a new one.</p>
        <button class="btn-primary" id="go-forgot">Request Password Reset</button>
      </div>
    `
    container.querySelector('#go-forgot').addEventListener('click', () => navigate('#/forgot-password'))
    return
  }

  container.innerHTML = `
    <div class="auth-card">
      <h1 class="auth-title">Reset Password</h1>
      <form id="reset-form" novalidate>
        <div class="form-group">
          <label for="reset-password">New Password</label>
          <input
            type="password"
            id="reset-password"
            name="newPassword"
            autocomplete="new-password"
            placeholder="At least 8 characters"
          />
        </div>
        <div class="form-group">
          <label for="reset-confirm">Confirm Password</label>
          <input
            type="password"
            id="reset-confirm"
            name="confirmPassword"
            autocomplete="new-password"
            placeholder="Repeat your new password"
          />
        </div>
        <div class="form-error" id="reset-error" role="alert" aria-live="polite"></div>
        <button type="submit" id="reset-btn" class="btn-primary">Set New Password</button>
      </form>
      <p class="auth-link"><a href="#/login">Back to sign in</a></p>
    </div>
  `

  const form = container.querySelector('#reset-form')
  const errorEl = container.querySelector('#reset-error')
  const btn = container.querySelector('#reset-btn')

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    errorEl.textContent = ''

    const newPassword = form.querySelector('#reset-password').value
    const confirmPassword = form.querySelector('#reset-confirm').value

    if (newPassword.length < 8) {
      errorEl.textContent = 'Password must be at least 8 characters.'
      return
    }
    if (newPassword !== confirmPassword) {
      errorEl.textContent = 'Passwords do not match.'
      return
    }

    btn.disabled = true
    btn.textContent = 'Saving\u2026'

    try {
      await resetPassword({ token, newPassword })
      container.innerHTML = `
        <div class="auth-card">
          <h1 class="auth-title">Password Reset</h1>
          <p class="auth-message">Your password has been reset successfully. You can now sign in with your new password.</p>
          <button class="btn-primary" id="go-login">Sign In</button>
        </div>
      `
      container.querySelector('#go-login').addEventListener('click', () => navigate('#/login'))
    } catch (err) {
      let message = 'Something went wrong. Please try again later.'
      if (err.status === 400) {
        if (err.message.includes('expired')) {
          message = 'This reset link has expired.'
        } else {
          message = 'This reset link is invalid or has already been used.'
        }
        container.innerHTML = `
          <div class="auth-card">
            <h1 class="auth-title">Link No Longer Valid</h1>
            <p class="auth-message">${escapeHtml(message)}</p>
            <button class="btn-primary" id="go-forgot">Request a New Link</button>
            <p class="auth-link"><a href="#/login">Back to sign in</a></p>
          </div>
        `
        container.querySelector('#go-forgot').addEventListener('click', () => navigate('#/forgot-password'))
        return
      }
      errorEl.textContent = message
      btn.disabled = false
      btn.textContent = 'Set New Password'
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
