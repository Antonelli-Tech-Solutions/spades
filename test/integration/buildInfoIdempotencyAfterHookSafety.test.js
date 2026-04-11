/**
 * Focused replacement for issue #405: Verify that removing the redundant
 * `after` hook env restoration from buildInfoIdempotency.test.js is safe.
 *
 * The original 200+ line file tested Node.js runtime guarantees (afterEach
 * fires reliably, try/finally works) which are not application logic.
 * restoreEnv's core idempotency and save/restore behaviour are already
 * covered by test/unit/envHelper.test.js.
 *
 * These two targeted tests verify the only application-specific concern:
 * that restoreEnv idempotency holds when used with the build-info route's
 * GIT_COMMIT_SHA env var — i.e., calling restoreEnv after afterEach already
 * cleaned up does not corrupt the env for subsequent requests.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

describe('after hook env restore is safely redundant (issue #405)', { timeout: 10000 }, () => {
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
    await new Promise((res) => server.close(res))
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  afterEach(() => {
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  it('redundant restoreEnv after afterEach does not change build-info response', async () => {
    // Mutate env and hit the route
    process.env.GIT_COMMIT_SHA = 'dirty111222233334444555566667777888899990000'
    const dirtyRes = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(dirtyRes.status, 200)
    const dirtyBody = await dirtyRes.json()
    assert.equal(dirtyBody.commitShort, 'dirty11')

    // Simulate afterEach cleanup
    restoreEnv('GIT_COMMIT_SHA', savedSha)

    // Simulate redundant after-hook cleanup (the code that was removed)
    restoreEnv('GIT_COMMIT_SHA', savedSha)

    // Route should reflect the restored state, not the dirty state
    const cleanRes = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(cleanRes.status, 200)
    const cleanBody = await cleanRes.json()

    if (savedSha && savedSha.length >= 7) {
      assert.equal(cleanBody.commitShort, savedSha.substring(0, 7))
    } else {
      assert.equal(cleanBody.commitShort, null)
    }
  })

  it('restoreEnv idempotency holds across delete-then-set cycle for GIT_COMMIT_SHA', async () => {
    // Delete the env var entirely
    delete process.env.GIT_COMMIT_SHA
    const deletedRes = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(deletedRes.status, 200)
    const deletedBody = await deletedRes.json()
    assert.equal(deletedBody.commitShort, null)

    // First restore (afterEach path)
    restoreEnv('GIT_COMMIT_SHA', savedSha)
    const stateAfterFirst = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    // Second restore (redundant after-hook path)
    restoreEnv('GIT_COMMIT_SHA', savedSha)
    const stateAfterSecond = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    assert.equal(stateAfterFirst, stateAfterSecond,
      'restoreEnv must be idempotent — second call should not change state')
  })
})
