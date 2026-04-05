/**
 * Authenticated WebSocket connection for the game screen.
 *
 * Browser WebSocket APIs cannot set custom headers on the upgrade handshake,
 * so the session token is passed as a URL query parameter (`sessionId`).
 * The server accepts this as a fallback to the `x-session-id` header.
 */

/**
 * Create an authenticated WebSocket connection to the game server, subscribe
 * to the given table room, and return a handle to tear it down.
 *
 * @param {object} opts
 * @param {string} opts.wsUrl              - Full WS/WSS URL with `sessionId` query param
 * @param {string} opts.tableId            - Table room to JOIN after connecting
 * @param {function} [opts.onEvent]        - Called with each game event `{ type, payload }`
 *                                           (JOINED / JOIN_DENIED are consumed internally)
 * @param {function} [opts.onOpen]         - Called once the JOINED ack is received
 * @param {function} [opts.onClose]        - Called when the connection closes
 * @param {function} [opts.onError]        - Called on WebSocket error
 * @param {typeof WebSocket} [opts.WebSocketClass] - Injected for testing; defaults to globalThis.WebSocket
 * @returns {{ close: function }}
 */
export function createGameSocket({
  wsUrl,
  tableId,
  onEvent,
  onOpen,
  onClose,
  onError,
  WebSocketClass = globalThis.WebSocket,
}) {
  const ws = new WebSocketClass(wsUrl)

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'JOIN', payload: { tableId } }))
  }

  ws.onmessage = (event) => {
    let msg
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
    } catch {
      return
    }

    const { type, payload = {} } = msg

    if (type === 'JOINED' && payload.tableId === tableId) {
      onOpen?.()
      return
    }

    if (type === 'JOIN_DENIED') {
      console.log('GameSocket JOIN denied:', { tableId, reason: payload.reason })
      return
    }

    onEvent?.(msg)
  }

  ws.onclose = () => {
    onClose?.()
  }

  ws.onerror = (err) => {
    onError?.(err)
  }

  function close() {
    // Only send LEAVE when the connection is fully open
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify({ type: 'LEAVE', payload: { tableId } }))
    }
    // Close unless already closing or closed
    if (ws.readyState !== 2 /* CLOSING */ && ws.readyState !== 3 /* CLOSED */) {
      ws.close()
    }
  }

  return { close }
}

/**
 * Build the WebSocket URL for the current origin, appending the session token
 * as a query parameter.
 *
 * Derives the host from `window.location` so it works regardless of port.
 * Falls back to `localhost` when running outside a browser (e.g. during tests
 * that call this function directly).
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function buildWsUrl(sessionId) {
  const protocol = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = globalThis.location?.host ?? 'localhost'
  return `${protocol}//${host}?sessionId=${encodeURIComponent(sessionId)}`
}
