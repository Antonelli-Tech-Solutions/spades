/**
 * Integration tests for the GET /api/build-info endpoint.
 * No database or Redis required — the endpoint is unauthenticated and stateless.
 */
import { describe, it, before, after, afterEach } from 'node:test'
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
  const savedSha = process.env.GIT_COMMIT_SHA

  before(async () => {
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
  })

  afterEach(() => {
    // Restore original env state after each test
    if (savedSha !== undefined) {
      process.env.GIT_COMMIT_SHA = savedSha
    } else {
      delete process.env.GIT_COMMIT_SHA
    }
  })

  it('returns the short commit SHA when GIT_COMMIT_SHA is set', async () => {
    const fullSha = 'abc1234def5678901234567890abcdef12345678'
    process.env.GIT_COMMIT_SHA = fullSha

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.commitShort, 'abc1234')
  })

  it('returns null when GIT_COMMIT_SHA is not set', async () => {
    delete process.env.GIT_COMMIT_SHA

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.commitShort, null)
  })

  it('truncates a full 40-character SHA to 7 characters', async () => {
    process.env.GIT_COMMIT_SHA = 'd10c141a8b3f9e2c4d5e6f7a8b9c0d1e2f3a4b5c'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(body.commitShort, 'd10c141')
    assert.equal(body.commitShort.length, 7)
  })

  it('returns the full value when GIT_COMMIT_SHA is shorter than 7 characters', async () => {
    process.env.GIT_COMMIT_SHA = 'abc12'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(body.commitShort, 'abc12')
  })

  it('returns exactly 7 characters when GIT_COMMIT_SHA is exactly 7 characters', async () => {
    process.env.GIT_COMMIT_SHA = 'abc1234'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(body.commitShort, 'abc1234')
    assert.equal(body.commitShort.length, 7)
  })

  it('returns null when GIT_COMMIT_SHA is an empty string', async () => {
    process.env.GIT_COMMIT_SHA = ''

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(body.commitShort, null)
  })

  it('responds with Content-Type application/json', async () => {
    process.env.GIT_COMMIT_SHA = 'abc1234def5678901234567890abcdef12345678'

    const res = await fetch(`${server.baseUrl}/api/build-info`)

    assert.ok(res.headers.get('content-type').includes('application/json'))
  })

  it('returns only the commitShort key in the response body', async () => {
    process.env.GIT_COMMIT_SHA = 'abc1234def5678901234567890abcdef12345678'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.deepStrictEqual(Object.keys(body), ['commitShort'])
  })

  it('does not require authentication headers', async () => {
    process.env.GIT_COMMIT_SHA = 'abc1234def5678901234567890abcdef12345678'

    // No x-session-id, x-player-id, or x-table-id headers
    const res = await fetch(`${server.baseUrl}/api/build-info`)

    assert.equal(res.status, 200)
  })

  it('rejects POST requests', async () => {
    const res = await fetch(`${server.baseUrl}/api/build-info`, {
      method: 'POST',
    })

    assert.notEqual(res.status, 200)
  })

  it('rejects PUT requests', async () => {
    const res = await fetch(`${server.baseUrl}/api/build-info`, {
      method: 'PUT',
    })

    assert.notEqual(res.status, 200)
  })

  it('rejects DELETE requests', async () => {
    const res = await fetch(`${server.baseUrl}/api/build-info`, {
      method: 'DELETE',
    })

    assert.notEqual(res.status, 200)
  })
})
