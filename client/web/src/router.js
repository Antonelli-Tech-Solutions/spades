/**
 * Minimal hash-based SPA router.
 *
 * Usage:
 *   addRoute('#/login', renderLoginScreen)
 *   addRoute('#/register', renderRegisterScreen)
 *   init(document.getElementById('app'))
 */

const routes = {}

/**
 * Register a route handler for a given hash path.
 * @param {string} hash  e.g. '#/login'
 * @param {(container: HTMLElement) => void} renderFn
 */
export function addRoute(hash, renderFn) {
  routes[hash] = renderFn
}

/**
 * Navigate to a hash path.
 * @param {string} hash  e.g. '#/lobby'
 */
export function navigate(hash) {
  window.location.hash = hash
}

/**
 * Start the router, rendering the current route into `container`.
 * Re-renders on every hashchange.
 * @param {HTMLElement} container
 */
export function init(container) {
  function render() {
    const hash = window.location.hash || '#/login'
    const route = hash.split('?')[0]
    const fn = routes[route] ?? routes['#/login']
    if (fn) {
      container.innerHTML = ''
      fn(container)
    }
  }
  window.addEventListener('hashchange', render)
  render()
}
