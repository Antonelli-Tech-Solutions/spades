import { addRoute, init } from './router.js'
import { renderLoginScreen } from './screens/login.js'
import { renderRegisterScreen } from './screens/register.js'
import { renderVerifyEmailSuccess, renderVerifyEmailError, renderVerifyEmailExpired } from './screens/verifyEmail.js'
import { renderForgotPasswordScreen } from './screens/forgotPassword.js'
import { renderResetPasswordScreen } from './screens/resetPassword.js'

const app = document.getElementById('app')

addRoute('#/login', renderLoginScreen)
addRoute('#/register', renderRegisterScreen)
addRoute('#/verify-email-success', renderVerifyEmailSuccess)
addRoute('#/verify-email-error', renderVerifyEmailError)
addRoute('#/verify-email-expired', renderVerifyEmailExpired)
addRoute('#/forgot-password', renderForgotPasswordScreen)
addRoute('#/reset-password', renderResetPasswordScreen)

// Redirect authenticated users away from auth screens
if (sessionStorage.getItem('sessionId') && window.location.hash !== '#/lobby') {
  window.location.hash = '#/lobby'
}

init(app)
