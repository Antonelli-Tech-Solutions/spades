import { navigate } from '../router.js'

export function renderVerifyEmailSuccess(container) {
  const card = document.createElement('div')
  card.className = 'auth-card'
  card.innerHTML = `
    <h1 class="auth-title">Email Verified</h1>
    <p class="auth-message">Your email address has been verified. You can now sign in to Spades Online.</p>
    <button class="btn-primary" id="go-login">Sign In</button>
  `
  container.appendChild(card)
  card.querySelector('#go-login').addEventListener('click', () => navigate('#/login'))
}

export function renderVerifyEmailError(container) {
  const card = document.createElement('div')
  card.className = 'auth-card'
  card.innerHTML = `
    <h1 class="auth-title">Verification Failed</h1>
    <p class="auth-message">This verification link is invalid or has already been used. Please request a new one from the sign-in page.</p>
    <button class="btn-primary" id="go-login">Sign In</button>
  `
  container.appendChild(card)
  card.querySelector('#go-login').addEventListener('click', () => navigate('#/login'))
}

export function renderVerifyEmailExpired(container) {
  const card = document.createElement('div')
  card.className = 'auth-card'
  card.innerHTML = `
    <h1 class="auth-title">Link Expired</h1>
    <p class="auth-message">This verification link has expired. Please request a new one from the sign-in page.</p>
    <button class="btn-primary" id="go-login">Sign In</button>
  `
  container.appendChild(card)
  card.querySelector('#go-login').addEventListener('click', () => navigate('#/login'))
}
