import { addRoute, init } from './router.js'
import { renderBuildIndicator } from './buildIndicator.js'
import { renderLoginScreen } from './screens/login.js'
import { renderRegisterScreen } from './screens/register.js'
import { renderVerifyEmailSuccess, renderVerifyEmailError, renderVerifyEmailExpired } from './screens/verifyEmail.js'
import { renderForgotPasswordScreen } from './screens/forgotPassword.js'
import { renderResetPasswordScreen } from './screens/resetPassword.js'
import { renderLobbyScreen } from './screens/lobby.js'
import { renderCreateTableScreen } from './screens/createTable.js'
import { renderJoinTableScreen } from './screens/joinTable.js'
import { renderGameScreen } from './screens/game.js'

const app = document.getElementById('app')

addRoute('#/login', renderLoginScreen)
addRoute('#/register', renderRegisterScreen)
addRoute('#/verify-email-success', renderVerifyEmailSuccess)
addRoute('#/verify-email-error', renderVerifyEmailError)
addRoute('#/verify-email-expired', renderVerifyEmailExpired)
addRoute('#/forgot-password', renderForgotPasswordScreen)
addRoute('#/reset-password', renderResetPasswordScreen)
addRoute('#/lobby', renderLobbyScreen)
addRoute('#/create-table', renderCreateTableScreen)
addRoute('#/join', renderJoinTableScreen)
addRoute('#/table', renderGameScreen)

// Redirect unauthenticated users to login from protected screens, and redirect
// authenticated users away from auth-only screens to lobby (or back to their table).
const authOnlyScreens = new Set(['', '#/login', '#/register', '#/forgot-password', '#/reset-password'])
const currentRoute = window.location.hash.split('?')[0]
const sessionId = sessionStorage.getItem('sessionId')
const playerId = sessionStorage.getItem('playerId')

if (sessionId && authOnlyScreens.has(currentRoute)) {
  // Authenticated user landed on an auth-only screen (e.g. after re-login).
  // If they have an active table stored locally, go straight there; otherwise
  // send them to the lobby (which will check the server and redirect if needed).
  const storedTableId = sessionStorage.getItem('currentTableId')
  window.location.hash = storedTableId ? `#/table?tableId=${storedTableId}` : '#/lobby'
} else if (sessionId && playerId && currentRoute !== '#/table') {
  // Authenticated user is on a non-table screen on initial load (e.g. refreshed
  // on lobby, or re-opened a bookmarked URL). Use the stored tableId as a fast
  // path so there is no round-trip delay; the lobby/create/join screens each do
  // their own server-side check to handle the re-login case where sessionStorage
  // has been cleared.
  const storedTableId = sessionStorage.getItem('currentTableId')
  if (storedTableId) {
    window.location.hash = `#/table?tableId=${storedTableId}`
  }
}

init(app)

renderBuildIndicator().then(html => {
  if (html) document.body.insertAdjacentHTML('beforeend', html)
})
