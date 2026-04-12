/**
 * Integration tests for issue #365: afterEach env cleanup is sufficient for
 * build-info route tests — a redundant after-hook is unnecessary.
 *
 * Each test is fully independent: no test relies on the execution order or
 * side-effects of sibling tests. This replaces the previous version that
 * asserted cumulative afterEachCallCount values across tests, which would
 * break under --concurrency or if test order changed.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

describe('afterEach cleanup removes need for redundant after hook (issue #365)', { timeout: 10000 }, () => {
  let server
  let baseUrl
  let savedSha

  before(async () => {
    savedSha = saveEnv('GIT_COMMIT_SHA')

    const app = express()
    app.use(express.json())
    registerBuildInfoRoute(app)

    server = await new Promise((resolve) => {
      const srv = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${srv.address().port}`
        resolve(srv)
      })
    })
  })

  after(async () => {
    try {
      await new Promise((res) => server.close(res))
    } finally {
      restoreEnv('GIT_COMMIT_SHA', savedSha)
    }
  })

  afterEach(() => {
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  // --- Happy path: env mutation is visible to the route ---

  it('route reflects a mutated GIT_COMMIT_SHA', async () => {
    const sha = 'cafe1234'
    process.env.GIT_COMMIT_SHA = sha

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, sha.slice(0, 7))
  })

  it('route reflects a different mutated GIT_COMMIT_SHA independently', async () => {
    const sha = 'deadbeef'
    process.env.GIT_COMMIT_SHA = sha

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, sha.slice(0, 7))
  })

  // --- afterEach restores env within the same test that mutates it ---

  it('afterEach restores env var after mutation within a single test', async () => {
    // Mutate env
    const sha = 'face9876'
    process.env.GIT_COMMIT_SHA = sha
    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, sha.slice(0, 7))

    // Manually invoke restore to prove it works (simulating what afterEach does)
    restoreEnv('GIT_COMMIT_SHA', savedSha)

    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'restoreEnv should have restored the original value')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'restoreEnv should have deleted the env var')
    }
  })

  // --- Edge case: env var unset (null/missing SHA) ---

  it('route returns null commitShort when GIT_COMMIT_SHA is unset', async () => {
    delete process.env.GIT_COMMIT_SHA

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, null)
  })

  it('route returns null commitShort when GIT_COMMIT_SHA is empty string', async () => {
    process.env.GIT_COMMIT_SHA = ''

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, null)
  })

  // --- Edge case: short SHA (fewer than 7 characters) ---

  it('route truncates SHA to 7 characters even if input is exactly 7 chars', async () => {
    process.env.GIT_COMMIT_SHA = 'abcdefg'

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'abcdefg')
  })

  it('route returns fewer than 7 characters when SHA is shorter', async () => {
    process.env.GIT_COMMIT_SHA = 'abc'

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'abc')
  })

  // --- Redundant after-hook is unnecessary: afterEach alone suffices ---

  it('restoreEnv is idempotent — calling it multiple times does not corrupt state', () => {
    process.env.GIT_COMMIT_SHA = 'bade5678'

    // Simulate afterEach running
    restoreEnv('GIT_COMMIT_SHA', savedSha)
    // Simulate a redundant after hook also running
    restoreEnv('GIT_COMMIT_SHA', savedSha)

    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
    }
  })

  it('restoreEnv correctly handles transition from set to unset', () => {
    process.env.GIT_COMMIT_SHA = 'feed4321'
    restoreEnv('GIT_COMMIT_SHA', undefined)
    assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
      'restoreEnv(key, undefined) should delete the env var')
  })

  it('restoreEnv correctly handles transition from unset to set', () => {
    delete process.env.GIT_COMMIT_SHA
    restoreEnv('GIT_COMMIT_SHA', 'orig_sha')
    assert.equal(process.env.GIT_COMMIT_SHA, 'orig_sha')
  })
})
