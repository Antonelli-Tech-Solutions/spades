/**
 * Minimal test for issue #364: afterEach env cleanup is sufficient for
 * build-info route tests — the redundant after-hook env restoration and
 * the 208-line file proving Node.js test-runner ordering can be removed.
 *
 * Replaces buildInfoIdempotencyAfterHookRedundancy.test.js with a single
 * describe block that exercises the actual application concern: env vars
 * mutated during build-info tests are restored by afterEach alone.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

describe('afterEach env cleanup is sufficient for build-info (issue #364)', { timeout: 10000 }, () => {
  let server
  let baseUrl
  const savedSha = saveEnv('GIT_COMMIT_SHA')

  before(async () => {
    const app = express()
    app.use(express.json())
    registerBuildInfoRoute(app)

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${srv.address().port}`
        resolve(srv)
      })
    })
  })

  after(async () => {
    // Only server teardown — no env restoration needed
    await new Promise((res) => server.close(res))
  })

  afterEach(() => {
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  it('mutated env var is visible to the build-info route', async () => {
    process.env.GIT_COMMIT_SHA = 'aftereach_cleanup_test_sha_1234567890abcd'

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'afterea')
    // afterEach will restore — no try/finally needed
  })

  it('env var is restored by afterEach before this test runs', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should have restored the original value')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'afterEach should have deleted the env var')
    }
  })

  it('build-info route reflects the restored env after afterEach cleanup', async () => {
    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()

    // commitShort should reflect the original env, not the mutated value
    if (savedSha !== undefined) {
      assert.equal(body.commitShort, savedSha.slice(0, 7))
    } else {
      assert.equal(body.commitShort, null)
    }
  })
})
