/**
 * Integration tests for issue #311: registerBuildInfoRoute idempotency guard.
 *
 * Calling registerBuildInfoRoute(app) multiple times should not add duplicate
 * handlers to Express's router stack. The guard uses app.locals to track
 * whether the route has already been registered.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { restoreEnv } from '../helpers/envHelper.js'

describe('registerBuildInfoRoute idempotency guard', { timeout: 10000 }, () => {
  let app
  let server
  let baseUrl
  let savedSha

  before(async () => {
    savedSha = process.env.GIT_COMMIT_SHA
    app = express()
    app.use(express.json())

    registerBuildInfoRoute(app)

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        const { port } = srv.address()
        baseUrl = `http://127.0.0.1:${port}`
        resolve(srv)
      })
    })
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
    // afterEach handles env restoration (see #366)
  })

  afterEach(() => {
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  it('sets the _buildInfoRegistered flag on app.locals', () => {
    assert.equal(app.locals._buildInfoRegistered, true)
  })

  it('only adds one route handler despite multiple calls (verified via HTTP)', async () => {
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    assert.equal(app.locals._buildInfoRegistered, true)

    process.env.GIT_COMMIT_SHA = 'dedup_test_sha_1234567890abcdef1234567890'
    try {
      const res = await fetch(`${baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const text = await res.text()
      let parsed
      assert.doesNotThrow(() => { parsed = JSON.parse(text) },
        'Response should be a single JSON object, not concatenated duplicates')
      assert.equal(parsed.commitShort, 'dedup_t')
    } finally {
      restoreEnv('GIT_COMMIT_SHA', savedSha)
    }
  })

  it('still returns a valid response after multiple registrations', async () => {
    try {
      process.env.GIT_COMMIT_SHA = 'idempotent123456789012345678901234567890'

      const res = await fetch(`${baseUrl}/api/build-info`)
      assert.equal(res.status, 200)

      const body = await res.json()
      assert.equal(body.commitShort, 'idempot')
    } finally {
      restoreEnv('GIT_COMMIT_SHA', savedSha)
    }
  })

  it('works correctly on a fresh app instance (guard is per-app, not global)', async () => {
    const freshApp = express()
    freshApp.use(express.json())

    // Should succeed on a new app even though the first app was already registered
    registerBuildInfoRoute(freshApp)

    const freshServer = await new Promise((resolve) => {
      const srv = freshApp.listen(0, () => {
        resolve(srv)
      })
    })

    try {
      const { port } = freshServer.address()
      process.env.GIT_COMMIT_SHA = 'freshapp1234567890abcdef1234567890abcdef'

      const res = await fetch(`http://127.0.0.1:${port}/api/build-info`)
      assert.equal(res.status, 200)

      const body = await res.json()
      assert.equal(body.commitShort, 'freshap')
    } finally {
      if (savedSha !== undefined) {
        process.env.GIT_COMMIT_SHA = savedSha
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
      await new Promise((resolve) => freshServer.close(resolve))
    }
  })
})
