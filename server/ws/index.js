import { WebSocketServer } from 'ws'
import { getSession } from '../auth/session.js'

/**
 * Create and attach a WebSocket server to an existing HTTP server.
 *
 * Features:
 * - Authenticated connection upgrade using x-session-id header (rejects with 401 if missing/invalid)
 * - Table room management via JOIN / LEAVE messages (acked with JOINED / LEFT)
 * - Heartbeat: pings every pingIntervalMs; terminates if no pong within pongTimeoutMs
 * - wss.broadcast(tableId, type, payload) — emit to all clients in a table room
 * - wss.sendToPlayer(playerId, type, payload) — emit to all connections for a player
 *
 * @param {import('http').Server} httpServer
 * @param {{
 *   redis?: import('redis').RedisClientType,
 *   pingIntervalMs?: number,
 *   pongTimeoutMs?: number,
 * }} [opts]
 * @returns {WebSocketServer}
 */
export function createWsServer(httpServer, opts = {}) {
  const { redis = null, pingIntervalMs = 30_000, pongTimeoutMs = 10_000 } = opts

  const wss = new WebSocketServer({ noServer: true })

  // rooms[tableId] = Set<ws>
  const rooms = new Map()
  // playerConnections[playerId] = Set<ws>
  const playerConnections = new Map()

  // ── Upgrade / authentication ────────────────────────────────────────────────
  httpServer.on('upgrade', async (req, socket, head) => {
    const sessionId = req.headers['x-session-id']
    if (!sessionId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    try {
      const session = redis ? await getSession(redis, sessionId) : null
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws._playerId = session.playerId
        ws._tableRooms = new Set()
        wss.emit('connection', ws, req)
      })
    } catch (err) {
      console.error('WebSocket upgrade error:', { error: err.message })
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
      socket.destroy()
    }
  })

  // ── Connection handler ──────────────────────────────────────────────────────
  wss.on('connection', (ws) => {
    const playerId = ws._playerId
    console.log('WebSocket connected:', { playerId })

    // Register player connection
    if (!playerConnections.has(playerId)) {
      playerConnections.set(playerId, new Set())
    }
    playerConnections.get(playerId).add(ws)

    // Heartbeat state
    ws._isAlive = true
    const pingTimer = setInterval(() => {
      if (!ws._isAlive) {
        console.log('WebSocket pong timeout, terminating:', { playerId })
        ws.terminate()
        return
      }
      ws._isAlive = false
      ws.ping()
      // Set a pong timeout — if pong arrives before this fires, _isAlive is reset
      ws._pongTimeout = setTimeout(() => {
        if (!ws._isAlive) {
          console.log('WebSocket pong not received, terminating:', { playerId })
          ws.terminate()
        }
      }, pongTimeoutMs)
    }, pingIntervalMs)

    ws.on('pong', () => {
      ws._isAlive = true
      clearTimeout(ws._pongTimeout)
    })

    // ── Message handler ─────────────────────────────────────────────────────
    ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(data.toString())
      } catch {
        return
      }

      const { type, payload = {} } = msg

      if (type === 'JOIN') {
        const { tableId } = payload
        if (!tableId) return
        const roomKey = `table:${tableId}`
        if (!rooms.has(roomKey)) {
          rooms.set(roomKey, new Set())
        }
        rooms.get(roomKey).add(ws)
        ws._tableRooms.add(roomKey)
        console.log('WebSocket JOIN:', { playerId, tableId })
        ws.send(JSON.stringify({ type: 'JOINED', payload: { tableId } }))
        return
      }

      if (type === 'LEAVE') {
        const { tableId } = payload
        if (!tableId) return
        const roomKey = `table:${tableId}`
        rooms.get(roomKey)?.delete(ws)
        ws._tableRooms.delete(roomKey)
        console.log('WebSocket LEAVE:', { playerId, tableId })
        ws.send(JSON.stringify({ type: 'LEFT', payload: { tableId } }))
        return
      }
    })

    // ── Close / cleanup ──────────────────────────────────────────────────────
    ws.on('close', () => {
      clearInterval(pingTimer)
      clearTimeout(ws._pongTimeout)
      for (const roomKey of ws._tableRooms) {
        rooms.get(roomKey)?.delete(ws)
        if (rooms.get(roomKey)?.size === 0) {
          rooms.delete(roomKey)
        }
      }
      playerConnections.get(playerId)?.delete(ws)
      if (playerConnections.get(playerId)?.size === 0) {
        playerConnections.delete(playerId)
      }
      console.log('WebSocket disconnected:', { playerId })
    })

    ws.on('error', (err) => {
      console.error('WebSocket error:', { playerId, error: err.message })
    })
  })

  // ── Broadcast helpers ───────────────────────────────────────────────────────

  /**
   * Send an event to all clients subscribed to a table room.
   *
   * @param {string} tableId
   * @param {string} type
   * @param {object} payload
   */
  wss.broadcast = (tableId, type, payload) => {
    const roomKey = `table:${tableId}`
    const room = rooms.get(roomKey)
    if (!room) return
    const msg = JSON.stringify({ type, payload })
    for (const ws of room) {
      if (ws.readyState === ws.constructor.OPEN) {
        ws.send(msg)
      }
    }
  }

  /**
   * Send an event to all active connections belonging to a specific player.
   *
   * @param {string} playerId
   * @param {string} type
   * @param {object} payload
   */
  wss.sendToPlayer = (playerId, type, payload) => {
    const connections = playerConnections.get(playerId)
    if (!connections) return
    const msg = JSON.stringify({ type, payload })
    for (const ws of connections) {
      if (ws.readyState === ws.constructor.OPEN) {
        ws.send(msg)
      }
    }
  }

  return wss
}
