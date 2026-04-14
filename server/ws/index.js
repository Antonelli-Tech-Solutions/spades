import { WebSocketServer } from 'ws'
import { getSession } from '../auth/session.js'

/**
 * Create and attach a WebSocket server to an existing HTTP server.
 *
 * Features:
 * - Authenticated connection upgrade using x-session-id header (rejects with 401 if missing/invalid)
 * - Table room management via JOIN / LEAVE messages (acked with JOINED / LEFT)
 * - Lobby room management via JOIN_LOBBY / LEAVE_LOBBY messages (acked with JOINED_LOBBY / LEFT_LOBBY)
 * - Redis pub/sub fan-out: each room (table:{tableId}, lobby) maps to a Redis pub/sub channel so
 *   all server instances can broadcast to connected clients. Each server instance subscribes to a
 *   channel when its first local client joins the room, and unsubscribes when the room is empty.
 * - Heartbeat: pings every pingIntervalMs; terminates if no pong within pongTimeoutMs
 * - wss.broadcast(tableId, type, payload) — emit to all clients in a table room (via Redis pub/sub)
 * - wss.broadcastLobby(type, payload) — emit to all clients in the lobby room (via Redis pub/sub)
 * - wss.sendToPlayer(playerId, type, payload) — emit to all connections for a player (local only)
 * - wss._subscriberReady — Promise that resolves when the Redis subscriber connection is established
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
  const {
    redis = null,
    pingIntervalMs = 30_000,
    pongTimeoutMs = 10_000,
    reconnectWindowMs = 60_000,
  } = opts

  const wss = new WebSocketServer({ noServer: true })

  // rooms[roomKey] = Set<ws>  (roomKey is 'table:{tableId}' or 'lobby')
  const rooms = new Map()
  // playerConnections[playerId] = Set<ws>
  const playerConnections = new Map()

  // disconnectWindows[`${playerId}:${tableId}`] = { timer, seat }
  // Tracks active reconnect windows for players who have disconnected mid-game.
  const disconnectWindows = new Map()

  // ── Redis pub/sub subscriber ──────────────────────────────────────────────────
  // A dedicated connection is required for pub/sub — the same client cannot be used
  // for both regular commands and subscribe/unsubscribe.
  let subscriber = null
  let subscriberReady = Promise.resolve()

  if (redis) {
    subscriber = redis.duplicate()
    subscriber.on('error', (err) => console.error('Redis subscriber error:', err))
    subscriberReady = subscriber.connect()
  }

  // Exposed so callers can await subscriber readiness before exercising pub/sub paths
  wss._subscriberReady = subscriberReady

  const OBSERVER_BLOCKED_TYPES = new Set(['HAND_DEALT', 'HAND_REVEALED', 'BLIND_NIL_EXCHANGE_PROMPT'])

  // Forward a Redis pub/sub message to all local WebSocket clients in the matching room.
  // The message is already a JSON string (published by broadcast / broadcastLobby).
  // Observers are filtered out for event types that contain private hand data.
  const onChannelMessage = (message, channel) => {
    const room = rooms.get(channel)
    if (!room) return
    let parsedType = null
    for (const ws of room) {
      if (ws.readyState !== ws.constructor.OPEN) continue
      if (ws._isObserver) {
        if (parsedType === null) {
          try { parsedType = JSON.parse(message).type ?? '' } catch { parsedType = '' }
        }
        if (OBSERVER_BLOCKED_TYPES.has(parsedType)) continue
      }
      ws.send(message)
    }
  }

  // ── Upgrade / authentication ────────────────────────────────────────────────
  httpServer.on('upgrade', async (req, socket, head) => {
    // Accept the session token from the x-session-id header (server-to-server /
    // Node.js ws clients) or from the `sessionId` URL query parameter (browser
    // clients, which cannot set custom headers on the WebSocket upgrade).
    const reqUrl = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const sessionId = req.headers['x-session-id'] ?? reqUrl.searchParams.get('sessionId')
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
        ws._lobbyRoom = false
        wss.emit('connection', ws, req)
      })
    } catch (err) {
      console.error('WebSocket upgrade error:', { error: err.message })
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
      socket.destroy()
    }
  })

  // ── Connection handler ──────────────────────────────────────────────────────
  wss.on('connection', async (ws) => {
    const playerId = ws._playerId
    console.log('WebSocket connected:', { playerId })

    // Register player connection
    if (!playerConnections.has(playerId)) {
      playerConnections.set(playerId, new Set())
    }
    playerConnections.get(playerId).add(ws)

    // Subscribe to personal notification channel for social events
    // (friend requests, in-app invites, friends-only table notifications).
    const notifyChannel = `player:${playerId}:notify`
    ws._notifyChannel = notifyChannel
    if (subscriber) {
      const isNewNotifyRoom = !rooms.has(notifyChannel)
      if (isNewNotifyRoom) {
        rooms.set(notifyChannel, new Set())
      }
      rooms.get(notifyChannel).add(ws)
      if (isNewNotifyRoom) {
        try {
          await subscriber.subscribe(notifyChannel, onChannelMessage)
        } catch (err) {
          console.error('Redis notify subscribe error:', { playerId, error: err.message })
        }
      }
    }

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
    ws.on('message', async (data) => {
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

        // Security: verify the player is seated at this table before subscribing.
        // Fail closed — deny the JOIN if Redis is unavailable rather than allowing unchecked access.
        if (!redis) {
          ws.send(JSON.stringify({ type: 'JOIN_DENIED', payload: { tableId, reason: 'error' } }))
          return
        }
        try {
          const tableData = await redis.get(`table:${tableId}`)
          if (!tableData) {
            ws.send(JSON.stringify({ type: 'JOIN_DENIED', payload: { tableId, reason: 'table_not_found' } }))
            return
          }
          const table = JSON.parse(tableData)
          const isSeated = Object.values(table.seats).includes(playerId)
          const isObserver = (table.observers || []).includes(playerId)
          if (!isSeated && !isObserver) {
            console.log('WebSocket JOIN denied — not seated or observing:', { playerId, tableId })
            ws.send(JSON.stringify({ type: 'JOIN_DENIED', payload: { tableId, reason: 'not_seated_or_observing' } }))
            return
          }
          if (isObserver) {
            ws._isObserver = true
          }
        } catch (err) {
          console.error('WebSocket JOIN auth error:', { playerId, tableId, error: err.message })
          ws.send(JSON.stringify({ type: 'JOIN_DENIED', payload: { tableId, reason: 'error' } }))
          return
        }

        const roomKey = `table:${tableId}`
        const isNewRoom = !rooms.has(roomKey)
        if (isNewRoom) {
          rooms.set(roomKey, new Set())
        }
        rooms.get(roomKey).add(ws)
        ws._tableRooms.add(roomKey)

        // Subscribe to the Redis channel when this is the first local client in the room.
        // Awaiting here ensures the subscription is active before the JOINED ack is sent,
        // so any subsequent broadcast() call will be received by this client.
        if (isNewRoom && subscriber) {
          try {
            await subscriber.subscribe(roomKey, onChannelMessage)
          } catch (err) {
            console.error('Redis subscribe error:', { roomKey, error: err.message })
          }
        }

        console.log('WebSocket JOIN:', { playerId, tableId })
        ws.send(JSON.stringify({ type: 'JOINED', payload: { tableId } }))

        // Check for an active reconnect window — player may be rejoining after a disconnect.
        const windowKey = `${playerId}:${tableId}`
        const activeWindow = disconnectWindows.get(windowKey)
        if (activeWindow) {
          // Cancel the expiry timer — player reconnected in time.
          clearTimeout(activeWindow.timer)
          disconnectWindows.delete(windowKey)
          const { seat } = activeWindow

          // Clear any stall that may have been written already.
          try {
            const gameData = await redis.get(`game:${tableId}`)
            if (gameData) {
              const gameState = JSON.parse(gameData)
              if (gameState.waitingForReconnect) {
                delete gameState.waitingForReconnect
                await redis.set(`game:${tableId}`, JSON.stringify(gameState), { KEEPTTL: true })
              }
            }
          } catch (err) {
            console.error('Error clearing reconnect stall:', { playerId, tableId, error: err.message })
          }

          console.log('WebSocket reconnected within window:', { playerId, tableId, seat })
          wss.broadcast(tableId, 'PLAYER_RECONNECTED', { seat })
        } else {
          // No active window — check whether the game is stalled for this player's seat.
          // This handles reconnects after the window has expired (game stalled but player returns).
          try {
            const gameData = await redis.get(`game:${tableId}`)
            if (gameData) {
              const gameState = JSON.parse(gameData)
              if (gameState.waitingForReconnect) {
                const seat = Object.entries(
                  JSON.parse((await redis.get(`table:${tableId}`)) ?? '{}').seats ?? {},
                ).find(([, id]) => id === playerId)?.[0]
                if (seat && gameState.waitingForReconnect.seat === seat) {
                  delete gameState.waitingForReconnect
                  await redis.set(`game:${tableId}`, JSON.stringify(gameState), { KEEPTTL: true })
                  console.log('Game stall cleared after late reconnect:', { playerId, tableId, seat })
                }
              }
            }
          } catch (err) {
            console.error('Error checking stall on late reconnect:', { playerId, tableId, error: err.message })
          }
        }
        return
      }

      if (type === 'LEAVE') {
        const { tableId } = payload
        if (!tableId) return
        const roomKey = `table:${tableId}`
        rooms.get(roomKey)?.delete(ws)
        ws._tableRooms.delete(roomKey)
        if ((rooms.get(roomKey)?.size ?? 0) === 0) {
          rooms.delete(roomKey)
          if (subscriber) {
            subscriber.unsubscribe(roomKey).catch((err) =>
              console.error('Redis unsubscribe error:', { roomKey, error: err.message }),
            )
          }
        }
        console.log('WebSocket LEAVE:', { playerId, tableId })
        ws.send(JSON.stringify({ type: 'LEFT', payload: { tableId } }))
        return
      }

      if (type === 'JOIN_LOBBY') {
        const lobbyKey = 'lobby'
        const isNewRoom = !rooms.has(lobbyKey)
        if (isNewRoom) {
          rooms.set(lobbyKey, new Set())
        }
        rooms.get(lobbyKey).add(ws)
        ws._lobbyRoom = true

        if (isNewRoom && subscriber) {
          try {
            await subscriber.subscribe(lobbyKey, onChannelMessage)
          } catch (err) {
            console.error('Redis subscribe error:', { roomKey: lobbyKey, error: err.message })
          }
        }

        console.log('WebSocket JOIN_LOBBY:', { playerId })
        ws.send(JSON.stringify({ type: 'JOINED_LOBBY', payload: {} }))
        return
      }

      if (type === 'LEAVE_LOBBY') {
        const lobbyKey = 'lobby'
        rooms.get(lobbyKey)?.delete(ws)
        ws._lobbyRoom = false
        if ((rooms.get(lobbyKey)?.size ?? 0) === 0) {
          rooms.delete(lobbyKey)
          if (subscriber) {
            subscriber.unsubscribe(lobbyKey).catch((err) =>
              console.error('Redis unsubscribe error:', { roomKey: lobbyKey, error: err.message }),
            )
          }
        }
        console.log('WebSocket LEAVE_LOBBY:', { playerId })
        ws.send(JSON.stringify({ type: 'LEFT_LOBBY', payload: {} }))
        return
      }
    })

    // ── Close / cleanup ──────────────────────────────────────────────────────
    ws.on('close', async () => {
      clearInterval(pingTimer)
      clearTimeout(ws._pongTimeout)

      // Capture the table rooms before mutating so we can check them below.
      const closedTableRooms = new Set(ws._tableRooms)

      for (const roomKey of ws._tableRooms) {
        rooms.get(roomKey)?.delete(ws)
        if (rooms.get(roomKey)?.size === 0) {
          rooms.delete(roomKey)
          if (subscriber) {
            subscriber.unsubscribe(roomKey).catch((err) =>
              console.error('Redis unsubscribe error:', { roomKey, error: err.message }),
            )
          }
        }
      }
      if (ws._lobbyRoom) {
        const lobbyKey = 'lobby'
        rooms.get(lobbyKey)?.delete(ws)
        if ((rooms.get(lobbyKey)?.size ?? 0) === 0) {
          rooms.delete(lobbyKey)
          if (subscriber) {
            subscriber.unsubscribe(lobbyKey).catch((err) =>
              console.error('Redis unsubscribe error:', { roomKey: lobbyKey, error: err.message }),
            )
          }
        }
      }
      // Clean up personal notification channel
      if (ws._notifyChannel) {
        const notifyRoomKey = ws._notifyChannel
        rooms.get(notifyRoomKey)?.delete(ws)
        if ((rooms.get(notifyRoomKey)?.size ?? 0) === 0) {
          rooms.delete(notifyRoomKey)
          if (subscriber) {
            subscriber.unsubscribe(notifyRoomKey).catch((err) =>
              console.error('Redis notify unsubscribe error:', { roomKey: notifyRoomKey, error: err.message }),
            )
          }
        }
      }

      playerConnections.get(playerId)?.delete(ws)
      if (playerConnections.get(playerId)?.size === 0) {
        playerConnections.delete(playerId)
      }
      console.log('WebSocket disconnected:', { playerId })

      // ── Disconnect detection: emit PLAYER_DISCONNECTED for in-progress games ──
      // Only emit if this was the player's last connection in the table room
      // (handles multiple browser tabs gracefully).
      if (!redis) return

      for (const roomKey of closedTableRooms) {
        const tableId = roomKey.slice('table:'.length)

        // Check whether the player still has another connection in this room.
        const room = rooms.get(roomKey)
        const playerStillInRoom = room ? [...room].some((c) => c._playerId === playerId) : false
        if (playerStillInRoom) continue

        // Skip if there is already an active reconnect window for this player+table.
        const windowKey = `${playerId}:${tableId}`
        if (disconnectWindows.has(windowKey)) continue

        try {
          const tableData = await redis.get(`table:${tableId}`)
          if (!tableData) continue

          const table = JSON.parse(tableData)
          if (table.status !== 'playing') continue

          const seat = Object.entries(table.seats).find(([, id]) => id === playerId)?.[0]
          if (!seat) continue

          const reconnectWindowSeconds = Math.ceil(reconnectWindowMs / 1000)
          console.log('Player disconnected from in-progress game:', { playerId, tableId, seat })
          wss.broadcast(tableId, 'PLAYER_DISCONNECTED', { seat, reconnectWindowSeconds })

          // Start the reconnect window timer.
          const timer = setTimeout(async () => {
            disconnectWindows.delete(windowKey)
            console.log('Reconnect window expired:', { playerId, tableId, seat })

            // Stall the game — mark game state so play/bid endpoints can reject actions.
            try {
              const gameData = await redis.get(`game:${tableId}`)
              if (!gameData) return
              const gameState = JSON.parse(gameData)
              if (gameState.waitingForReconnect) return // already stalled
              gameState.waitingForReconnect = { seat, expiresAt: Date.now() }
              await redis.set(`game:${tableId}`, JSON.stringify(gameState), { KEEPTTL: true })
              console.log('Game stalled waiting for reconnect:', { tableId, seat })
            } catch (err) {
              console.error('Error stalling game on reconnect window expiry:', { tableId, error: err.message })
            }
          }, reconnectWindowMs)

          disconnectWindows.set(windowKey, { timer, seat, tableId })
        } catch (err) {
          console.error('Error handling player disconnect:', { playerId, tableId, error: err.message })
        }
      }
    })

    ws.on('error', (err) => {
      console.error('WebSocket error:', { playerId, error: err.message })
    })
  })

  // ── Broadcast helpers ───────────────────────────────────────────────────────

  /**
   * Send an event to all clients subscribed to a table room.
   *
   * When Redis is configured, publishes to the Redis pub/sub channel `table:{tableId}` so all
   * server instances deliver the event to their local clients in the room. Without Redis, falls
   * back to direct local delivery.
   *
   * @param {string} tableId
   * @param {string} type
   * @param {object} payload
   */
  wss.broadcast = (tableId, type, payload) => {
    const msg = JSON.stringify({ type, payload })
    if (redis) {
      redis.publish(`table:${tableId}`, msg).catch((err) =>
        console.error('Redis publish error:', { tableId, error: err.message }),
      )
    } else {
      const roomKey = `table:${tableId}`
      const room = rooms.get(roomKey)
      if (!room) return
      for (const ws of room) {
        if (ws.readyState === ws.constructor.OPEN) {
          if (ws._isObserver && OBSERVER_BLOCKED_TYPES.has(type)) continue
          ws.send(msg)
        }
      }
    }
  }

  /**
   * Send an event to all clients subscribed to the lobby channel.
   *
   * When Redis is configured, publishes to the Redis pub/sub `lobby` channel so all server
   * instances deliver the event to their local lobby subscribers. Without Redis, falls back to
   * direct local delivery.
   *
   * @param {string} type
   * @param {object} payload
   */
  wss.broadcastLobby = (type, payload) => {
    const msg = JSON.stringify({ type, payload })
    if (redis) {
      redis.publish('lobby', msg).catch((err) =>
        console.error('Redis lobby publish error:', { error: err.message }),
      )
    } else {
      const room = rooms.get('lobby')
      if (!room) return
      for (const ws of room) {
        if (ws.readyState === ws.constructor.OPEN) {
          ws.send(msg)
        }
      }
    }
  }

  /**
   * Send an event to all active connections belonging to a specific player.
   * Delivery is local to this server instance only.
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

  /**
   * Send a notification to a specific player via their personal notification channel.
   * When Redis is configured, publishes to `player:{playerId}:notify` so all server
   * instances deliver the event. Without Redis, falls back to local sendToPlayer.
   */
  wss.notifyPlayer = (playerId, type, payload) => {
    const msg = JSON.stringify({ type, payload })
    if (redis) {
      redis.publish(`player:${playerId}:notify`, msg).catch((err) =>
        console.error('Redis notify publish error:', { playerId, error: err.message }),
      )
    } else {
      wss.sendToPlayer(playerId, type, payload)
    }
  }

  // Override close() to also disconnect the Redis subscriber connection.
  // subscriber.quit() must complete before originalClose() is called so that the
  // subscriber's TCP connection is fully torn down — otherwise the open handle
  // prevents the Node.js event loop from exiting (causes hanging tests / processes).
  const originalClose = wss.close.bind(wss)
  wss.close = (callback) => {
    if (subscriber) {
      subscriber.quit()
        .catch((err) => console.error('Redis subscriber quit error:', err))
        .finally(() => originalClose(callback))
    } else {
      originalClose(callback)
    }
  }

  return wss
}
