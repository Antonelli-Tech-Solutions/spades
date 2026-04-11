/**
 * Integration tests for the GET /api/build-info endpoint.
 * No database or Redis required — the endpoint is unauthenticated and stateless.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { handler } from '../../server/server.js'

async function startTestServer() {
  const app = express()
  app.use(express.json())
  handler(app)

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res)),
      })
    })
  })
}

describe('GET /api/build-info', () => {
  let server

  before(async () => {
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
  })

  it('returns the short commit SHA when GIT_COMMIT_SHA is set', async () => {
    const fullSha = 'abc1234def5678901234567890abcdef12345678'
    process.env.GIT_COMMIT_SHA = fullSha

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.commitShort, 'abc1234')

    delete process.env.GIT_COMMIT_SHA
  })

  it('returns null when GIT_COMMIT_SHA is not set', async () => {
    delete process.env.GIT_COMMIT_SHA

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.commitShort, null)
  })
})
