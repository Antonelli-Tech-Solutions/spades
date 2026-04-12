import express from 'express'
import { createServer } from 'http'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { execSync } from 'child_process'
import { handler } from './server.js'
import { getRedis } from './redis.js'
import { createWsServer } from './ws/index.js'

// If GIT_COMMIT_SHA isn't provided by CI, check platform-specific env vars
// (Vercel, Netlify, etc.) then fall back to `git rev-parse HEAD`.
if (!process.env.GIT_COMMIT_SHA) {
  const platformSha =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.COMMIT_REF ||
    null

  if (platformSha) {
    process.env.GIT_COMMIT_SHA = platformSha
  } else {
    try {
      process.env.GIT_COMMIT_SHA = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
    } catch {
      // Not a git repo or git unavailable — leave unset; /api/build-info returns null
    }
  }
}

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

// Inject runtime configuration as a JS file so client-side code can read
// environment-specific values (e.g. WS_URL for split-host deployments where
// the WebSocket server lives on a different host than the HTTP server).
// Configure WS_URL in Vercel (or your host's env settings) — do not hardcode it.
app.get('/config.js', (req, res) => {
  const wsUrl = process.env.WS_URL || ''
  res.setHeader('Content-Type', 'application/javascript')
  res.setHeader('Cache-Control', 'no-store')
  res.send(`window.__WS_URL__ = ${JSON.stringify(wsUrl)};`)
})

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
