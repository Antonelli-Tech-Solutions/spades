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
 * Reconnect behaviour
 * -------------------
 * If the connection drops unexpectedly (i.e. `close()` was not called by the
 * caller), the socket automatically reconnects with exponential backoff.
 * On a successful reconnect the JOINED ack triggers `onReconnect` (not
 * `onOpen`).  Any events that arrive while `onReconnect` is in-flight are
 * buffered and flushed — in order — once the promise returned by `onReconnect`
 * resolves.  This guarantees that `onEvent` never fires against stale
 * pre-disconnect state.
 *
 * @param {object} opts
 * @param {string} opts.wsUrl              - Full WS/WSS URL with `sessionId` query param
 * @param {string} opts.tableId            - Table room to JOIN after connecting
 * @param {function} [opts.onEvent]        - Called with each game event `{ type, payload }`
 *                                           (JOINED / JOIN_DENIED are consumed internally)
 * @param {function} [opts.onOpen]         - Called once the initial JOINED ack is received
 * @param {function} [opts.onReconnect]    - Async callback called on reconnect JOINED ack.
 *                                           Should re-hydrate state and return a Promise.
 *                                           Events are buffered until the promise resolves.
 * @param {function} [opts.onClose]        - Called when all reconnect attempts are exhausted
 *                                           or after an intentional close
 * @param {function} [opts.onError]        - Called on WebSocket error
 * @param {number}   [opts.maxReconnectAttempts=5] - Max automatic reconnect attempts
 * @param {typeof WebSocket} [opts.WebSocketClass] - Injected for testing; defaults to globalThis.WebSocket
 * @param {function} [opts.setTimeoutFn]   - Injected for testing; defaults to globalThis.setTimeout
 * @param {function} [opts.clearTimeoutFn] - Injected for testing; defaults to globalThis.clearTimeout
 * @returns {{ close: function }}
 */
export function createGameSocket({
  wsUrl,
  tableId,
  onEvent,
  onOpen,
  onReconnect,
  onClose,
  onError,
  maxReconnectAttempts = 5,
  WebSocketClass = globalThis.WebSocket,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
}) {
  let intentionalClose = false
  let reconnectAttempts = 0
  let reconnectTimer = null
  let ws = null

  function connect() {
    ws = new WebSocketClass(wsUrl)
    const isReconnect = reconnectAttempts > 0

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
        // Successful join — reset reconnect counter
        reconnectAttempts = 0

        if (isReconnect && onReconnect) {
          // Buffer events that arrive while rehydration is in-flight so that
          // onEvent is never called against stale pre-disconnect state.
          let eventQueue = []
          let draining = false
          const normalOnMessage = ws.onmessage

          ws.onmessage = (e) => {
            let m
            try {
              m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString())
            } catch {
              return
            }
            if (draining) {
              onEvent?.(m)
            } else {
              eventQueue.push(m)
            }
          }

          Promise.resolve(onReconnect()).then(() => {
            draining = true
            eventQueue.forEach((m) => onEvent?.(m))
            eventQueue = []
            ws.onmessage = normalOnMessage
          })
        } else if (!isReconnect) {
          onOpen?.()
        }
        // isReconnect && !onReconnect: silent success — no callback needed
        return
      }

      if (type === 'JOIN_DENIED') {
        console.log('GameSocket JOIN denied:', { tableId, reason: payload.reason })
        return
      }

      onEvent?.(msg)
    }

    ws.onclose = () => {
      if (intentionalClose) {
        onClose?.()
        return
      }

      if (reconnectAttempts >= maxReconnectAttempts) {
        onClose?.()
        return
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
      reconnectAttempts++
      reconnectTimer = setTimeoutFn(connect, delay)
    }

    ws.onerror = (err) => {
      onError?.(err)
    }
  }

  connect()

  function close() {
    intentionalClose = true
    if (reconnectTimer !== null) {
      clearTimeoutFn(reconnectTimer)
      reconnectTimer = null
    }
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
 * Create an authenticated WebSocket connection to the lobby channel.
 *
 * Sends JOIN_LOBBY after connecting; waits for JOINED_LOBBY as the ack.
 * TABLE_CREATED, TABLE_UPDATED, and TABLE_REMOVED events are forwarded to onEvent.
 * All other handshake messages (JOINED_LOBBY, LEFT_LOBBY) are consumed internally.
 *
 * Reconnect behaviour
 * -------------------
 * If the connection drops unexpectedly the socket automatically reconnects with
 * exponential backoff. On a successful reconnect the JOINED_LOBBY ack triggers
 * `onReconnect` (not `onOpen`).
 *
 * @param {object} opts
 * @param {string} opts.wsUrl              - Full WS/WSS URL with `sessionId` query param
 * @param {function} [opts.onEvent]        - Called with each lobby event `{ type, payload }`
 * @param {function} [opts.onOpen]         - Called once the initial JOINED_LOBBY is received
 * @param {function} [opts.onReconnect]    - Called when JOINED_LOBBY is received after reconnect
 * @param {function} [opts.onClose]        - Called when all reconnect attempts are exhausted
 *                                           or after an intentional close
 * @param {function} [opts.onError]        - Called on WebSocket error
 * @param {number}   [opts.maxReconnectAttempts=5] - Max automatic reconnect attempts
 * @param {typeof WebSocket} [opts.WebSocketClass] - Injected for testing; defaults to globalThis.WebSocket
 * @param {function} [opts.setTimeoutFn]   - Injected for testing; defaults to globalThis.setTimeout
 * @param {function} [opts.clearTimeoutFn] - Injected for testing; defaults to globalThis.clearTimeout
 * @returns {{ close: function }}
 */
export function createLobbySocket({
  wsUrl,
  onEvent,
  onOpen,
  onReconnect,
  onClose,
  onError,
  maxReconnectAttempts = 5,
  WebSocketClass = globalThis.WebSocket,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
}) {
  let intentionalClose = false
  let reconnectAttempts = 0
  let reconnectTimer = null
  let ws = null

  function connect() {
    ws = new WebSocketClass(wsUrl)
    const isReconnect = reconnectAttempts > 0

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'JOIN_LOBBY', payload: {} }))
    }

    ws.onmessage = (event) => {
      let msg
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
      } catch {
        return
      }

      const { type } = msg

      if (type === 'JOINED_LOBBY') {
        reconnectAttempts = 0
        if (isReconnect) {
          onReconnect?.()
        } else {
          onOpen?.()
        }
        return
      }

      if (type === 'LEFT_LOBBY') {
        return
      }

      onEvent?.(msg)
    }

    ws.onclose = () => {
      if (intentionalClose) {
        onClose?.()
        return
      }

      if (reconnectAttempts >= maxReconnectAttempts) {
        onClose?.()
        return
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
      reconnectAttempts++
      reconnectTimer = setTimeoutFn(connect, delay)
    }

    ws.onerror = (err) => {
      onError?.(err)
    }
  }

  connect()

  function close() {
    intentionalClose = true
    if (reconnectTimer !== null) {
      clearTimeoutFn(reconnectTimer)
      reconnectTimer = null
    }
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify({ type: 'LEAVE_LOBBY', payload: {} }))
    }
    if (ws.readyState !== 2 /* CLOSING */ && ws.readyState !== 3 /* CLOSED */) {
      ws.close()
    }
  }

  return { close }
}

/**
 * Build the WebSocket URL, appending the session token as a query parameter.
 *
 * If `window.__WS_URL__` is set (injected by `/config.js` from the `WS_URL`
 * environment variable), that base URL is used. This supports split-host
 * deployments where the WebSocket server lives on a different host than the
 * HTTP server (e.g. frontend on Vercel, WebSocket on Railway).
 *
 * Falls back to deriving the host from `window.location` for local /
 * single-host deployments.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function buildWsUrl(sessionId) {
  const base = globalThis.__WS_URL__ || ''
  if (base) {
    const separator = base.includes('?') ? '&' : '?'
    return `${base}${separator}sessionId=${encodeURIComponent(sessionId)}`
  }
  const protocol = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = globalThis.location?.host ?? 'localhost'
  return `${protocol}//${host}?sessionId=${encodeURIComponent(sessionId)}`
}
