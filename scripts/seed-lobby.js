// scripts/seed-lobby.js  (run with: node --experimental-vm-modules scripts/seed-lobby.js)
import { createClient } from 'redis'
import { createTable } from '../server/lobby/table.js'

const COUNT = 10
const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
await redis.connect()

for (let i = 1; i <= COUNT; i++) {
  const table = await createTable(redis, {
    hostPlayerId: `seed-player-${i}`,   // fake ID — no DB lookup happens
    name: `Test Table ${i}`,
    visibility: 'public',
  })
  console.log(`Created table ${i}: ${table.tableId}`)
}

await redis.disconnect()
