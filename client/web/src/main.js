import { addRoute, init } from './router.js'
import { renderLoginScreen } from './screens/login.js'
import { renderRegisterScreen } from './screens/register.js'

const app = document.getElementById('app')

addRoute('#/login', renderLoginScreen)
addRoute('#/register', renderRegisterScreen)

// Redirect authenticated users away from auth screens
if (sessionStorage.getItem('sessionId') && window.location.hash !== '#/lobby') {
  window.location.hash = '#/lobby'
}

init(app)
