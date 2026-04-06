import express from 'express'
import { createServer } from 'http'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { handler } from './server.js'
import { getRedis } from './redis.js'
import { createWsServer } from './ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = parseInt(process.env.PORT || '3000', 10)
// Default WS_PORT to PORT so the WebSocket server shares the HTTP server by default.
// The client's buildWsUrl() connects to window.location.host (the HTTP port), so they
// must match unless a reverse proxy is routing WebSocket upgrades to a separate port.
// Set WS_PORT explicitly to a different value to run WebSocket on a dedicated server.
const WS_PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : PORT

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

// Serve index.html dynamically so the server can inject window.__WS_URL__ from
// the WS_URL environment variable.  This allows split-host deployments (e.g.
// Vercel frontend + Railway WebSocket server) to configure the WebSocket URL
// via an environment variable rather than hardcoding it in the source.
const indexPath = join(__dirname, '..', 'client', 'web', 'index.html')
const rawIndex = readFileSync(indexPath, 'utf-8')

app.get('/', (req, res) => {
  const wsUrl = process.env.WS_URL
  const html = wsUrl
    ? rawIndex.replace(
        '</head>',
        `  <script>window.__WS_URL__ = ${JSON.stringify(wsUrl)};</script>\n  </head>`,
      )
    : rawIndex
  res.setHeader('Content-Type', 'text/html')
  res.send(html)
})

// Serve remaining static assets (JS, CSS, images, etc.)
app.use(express.static(join(__dirname, '..', 'client', 'web'), { index: false }))

const httpServer = createServer(app)

let wss
if (WS_PORT === PORT) {
  // Share the HTTP server when ports match
  wss = createWsServer(httpServer, { redis })
  console.log(`WebSocket server sharing HTTP server on port ${PORT}`)
} else {
  // Run WebSocket on its own dedicated server
  const wsHttpServer = createServer()
  wss = createWsServer(wsHttpServer, { redis })
  wsHttpServer.listen(WS_PORT, () => {
    console.log(`WebSocket server listening on port ${WS_PORT}`)
  })
}

handler(app, { redis, wss })

httpServer.listen(PORT, () => {
  console.log(`Spades Online server listening on port ${PORT}`)
})

export default app
