import { addRoute, init } from './router.js'
import { renderLoginScreen } from './screens/login.js'
import { renderRegisterScreen } from './screens/register.js'
import { renderVerifyEmailSuccess, renderVerifyEmailError, renderVerifyEmailExpired } from './screens/verifyEmail.js'
import { renderForgotPasswordScreen } from './screens/forgotPassword.js'
import { renderResetPasswordScreen } from './screens/resetPassword.js'
import { renderLobbyScreen } from './screens/lobby.js'
import { renderCreateTableScreen } from './screens/createTable.js'
import { renderJoinTableScreen } from './screens/joinTable.js'
import { renderGameScreen } from './screens/game.js'
import { renderGameOverScreen } from './screens/gameOver.js'

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
addRoute('#/game-over', renderGameOverScreen)

// Redirect unauthenticated users to login from protected screens, and redirect
// authenticated users away from auth-only screens to lobby.
const authOnlyScreens = new Set(['', '#/login', '#/register', '#/forgot-password', '#/reset-password'])
const currentRoute = window.location.hash.split('?')[0]
if (sessionStorage.getItem('sessionId') && authOnlyScreens.has(currentRoute)) {
  window.location.hash = '#/lobby'
}

init(app)
