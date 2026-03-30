import express from 'express'
import { createClient } from 'redis'
import { handler } from './server.js'

const app = express()
const PORT = process.env.PORT || 3000

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

let redisClient = null
if (process.env.REDIS_URL) {
  redisClient = createClient({ url: process.env.REDIS_URL })
  redisClient.on('error', (err) => console.error('Redis client error:', err))
  await redisClient.connect()
  console.log('Redis connected')
}

handler(app, { redis: redisClient })

app.listen(PORT, () => {
  console.log(`Spades Online server listening on port ${PORT}`)
})

export default app
