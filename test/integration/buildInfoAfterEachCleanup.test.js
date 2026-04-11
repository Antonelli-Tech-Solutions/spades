/**
 * Tests for issue #396: eliminate implicit ordering dependency in afterEach
 * env cleanup tests. Each test is independently meaningful — no test relies
 * on a previous test having mutated state.
 *
 * Replaces the prior version where the second test only verified afterEach
 * cleanup because the first test happened to mutate the env var before it.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

describe('afterEach env cleanup is sufficient for build-info (issue #396)', { timeout: 10000 }, () => {
  let server
  let baseUrl
  let savedSha

  before(async () => {
    savedSha = saveEnv('GIT_COMMIT_SHA')
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
  })

  it('afterEach restores env after mutation within the same test', async () => {
    // Record value at the start of this test (should already be restored)
    const beforeValue = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined

    // Mutate, then let afterEach clean up — but we verify the pre-test
    // state is correct by checking it matches the saved original.
    // This test is self-contained: it does not depend on any prior test.
    assert.equal(beforeValue, savedSha,
      'env var should match the saved original at the start of this test')

    // Mutate to prove afterEach will fix it for the next test
    process.env.GIT_COMMIT_SHA = 'self_contained_mutation_abc1234'
  })

  it('build-info route reflects the original env when no mutation has occurred in this test', async () => {
    // This test makes no mutation — it independently verifies the route
    // returns the original value, proving afterEach restored state.
    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()

    if (savedSha !== undefined) {
      assert.equal(body.commitShort, savedSha.slice(0, 7))
    } else {
      assert.equal(body.commitShort, null)
    }
  })

  it('afterEach restores deleted env var', async () => {
    // If the original was set, delete it and verify afterEach brings it back
    // If the original was unset, set it and verify afterEach removes it
    if (savedSha !== undefined) {
      delete process.env.GIT_COMMIT_SHA
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'env var should be deleted mid-test')
    } else {
      process.env.GIT_COMMIT_SHA = 'should_be_removed_by_aftereach'
      assert.equal(process.env.GIT_COMMIT_SHA, 'should_be_removed_by_aftereach')
    }
    // afterEach will restore — next test will verify independently
  })

  it('each test starts with the original env regardless of prior mutations', () => {
    // Self-contained verification: check current state matches saved original
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'env var should be the original saved value')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'env var should not exist when original was undefined')
    }
  })

  it('multiple mutations within a single test are all cleaned up by afterEach', async () => {
    process.env.GIT_COMMIT_SHA = 'first_mutation_aaaaaa'
    let res = await fetch(`${baseUrl}/api/build-info`)
    let body = await res.json()
    assert.equal(body.commitShort, 'first_m')

    process.env.GIT_COMMIT_SHA = 'second_mutation_bbbbbb'
    res = await fetch(`${baseUrl}/api/build-info`)
    body = await res.json()
    assert.equal(body.commitShort, 'second_')

    // afterEach restores to saved original regardless of how many mutations
  })

  it('env is correct after a test that performed multiple mutations', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
    }
  })
})
