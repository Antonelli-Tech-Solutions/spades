import express from 'express'
import { createServer } from 'http'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { handler } from './server.js'
import { getRedis } from './redis.js'
import { createWsServer } from './ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = parseInt(process.env.PORT || '3000', 10)
const WS_PORT = parseInt(process.env.WS_PORT || '3001', 10)

app.use(express.json())

// CORS headers are set manually on every request per project conventions.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-session-id, x-player-id, x-table-id',
  )
  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }
  next()
})

const redis = process.env.REDIS_URL ? await getRedis() : null
handler(app, { redis })

// Serve the web client as static files
app.use(express.static(join(__dirname, '..', 'client', 'web')))

const httpServer = createServer(app)

if (WS_PORT === PORT) {
  // Share the HTTP server when ports match
  createWsServer(httpServer, { redis })
  console.log(`WebSocket server sharing HTTP server on port ${PORT}`)
} else {
  // Run WebSocket on its own dedicated server
  const wsHttpServer = createServer()
  createWsServer(wsHttpServer, { redis })
  wsHttpServer.listen(WS_PORT, () => {
    console.log(`WebSocket server listening on port ${WS_PORT}`)
  })
}

httpServer.listen(PORT, () => {
  console.log(`Spades Online server listening on port ${PORT}`)
})

export default app
