/**
 * Tests for /api/build-info endpoint behavior under different env configurations.
 *
 * Replaces the previous tests (issue #340 / #372) which only verified that
 * JavaScript's try/finally and delete process.env.X work — language-level
 * guarantees, not application behavior.
 *
 * These tests exercise the actual route handler: response shape, commit SHA
 * truncation, missing/empty env var handling, and idempotent registration.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

/** Spin up a minimal Express app with only the build-info route. */
async function startTestServer() {
  const app = express()
  app.use(express.json())
  registerBuildInfoRoute(app)

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

describe('/api/build-info endpoint behavior (issue #372)', () => {
  let server
  let savedSha

  before(async () => {
    server = await startTestServer()
  })

  after(async () => {
    await server.close()
  })

  beforeEach(() => {
    savedSha = saveEnv('GIT_COMMIT_SHA')
  })

  afterEach(() => {
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  // --- Happy path ---

  it('returns the first 7 characters of GIT_COMMIT_SHA as commitShort', { timeout: 10000 }, async () => {

    process.env.GIT_COMMIT_SHA = 'a1b2c3d4e5f6789012345678901234567890abcd'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.commitShort, 'a1b2c3d')
  })

  it('returns null for commitShort when GIT_COMMIT_SHA is not set', { timeout: 10000 }, async () => {

    delete process.env.GIT_COMMIT_SHA

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.commitShort, null)
  })

  // --- Edge cases ---

  it('returns null for commitShort when GIT_COMMIT_SHA is empty string', { timeout: 10000 }, async () => {

    process.env.GIT_COMMIT_SHA = ''

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.commitShort, null)
  })

  it('returns full value when GIT_COMMIT_SHA is shorter than 7 characters', { timeout: 10000 }, async () => {

    process.env.GIT_COMMIT_SHA = 'abc'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.commitShort, 'abc')
  })

  it('returns exactly 7 characters when GIT_COMMIT_SHA is exactly 7 characters', { timeout: 10000 }, async () => {

    process.env.GIT_COMMIT_SHA = 'abcdefg'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.commitShort, 'abcdefg')
  })

  it('reflects a changed GIT_COMMIT_SHA between requests', { timeout: 10000 }, async () => {

    process.env.GIT_COMMIT_SHA = 'first_commit_sha_1234567890abcdef12345678'

    const res1 = await fetch(`${server.baseUrl}/api/build-info`)
    const body1 = await res1.json()
    assert.equal(body1.commitShort, 'first_c')

    process.env.GIT_COMMIT_SHA = 'second_commit_sha_abcdef1234567890abcdef12'

    const res2 = await fetch(`${server.baseUrl}/api/build-info`)
    const body2 = await res2.json()
    assert.equal(body2.commitShort, 'second_')
  })

  it('response contains only the commitShort key', { timeout: 10000 }, async () => {

    process.env.GIT_COMMIT_SHA = 'deadbeefcafe1234567890abcdef1234567890ab'

    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()

    assert.deepEqual(Object.keys(body), ['commitShort'])
  })

  // --- Idempotent registration ---

  it('does not register a duplicate route when called twice on the same app', { timeout: 10000 }, async () => {

    const app = express()
    app.use(express.json())
    registerBuildInfoRoute(app)

    // app._router.stack is an undocumented Express internal; may break on major upgrades.
    const stackLengthAfterFirst = app._router.stack.length

    registerBuildInfoRoute(app)

    assert.equal(app._router.stack.length, stackLengthAfterFirst,
      'Second registerBuildInfoRoute call should not add routes to the stack')
    assert.equal(app.locals._buildInfoRegistered, true)

    const dupServer = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        const { port } = srv.address()
        resolve({ baseUrl: `http://127.0.0.1:${port}`, srv })
      })
    })

    try {
      process.env.GIT_COMMIT_SHA = 'deadbeefcafe1234567890abcdef1234567890ab'

      const res = await fetch(`${dupServer.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const text = await res.text()
      let parsed
      assert.doesNotThrow(() => { parsed = JSON.parse(text) },
        'Response should be a single JSON object, not concatenated duplicates')
      assert.equal(parsed.commitShort, 'deadbee')
    } finally {
      await new Promise((resolve) => dupServer.srv.close(resolve))
    }
  })
})
