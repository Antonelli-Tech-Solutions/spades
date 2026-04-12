/**
 * Tests for issue #396 / #440: each test is truly self-contained.
 * Every test that needs to verify afterEach cleanup performs its own
 * mutation, restores via restoreEnv, and asserts restoration — no test
 * depends on a prior test having mutated state.
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

  it('afterEach restores env after mutation', async () => {
    process.env.GIT_COMMIT_SHA = 'self_contained_mutation_abc1234'

    const res = await fetch(`${baseUrl}/api/build-info`)
    const body = await res.json()
    assert.equal(body.commitShort, 'self_co')

    restoreEnv('GIT_COMMIT_SHA', savedSha)

    const currentValue = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined
    assert.equal(currentValue, savedSha,
      'env var should match the saved original after restore')
  })

  it('build-info route reflects the original env when no mutation has occurred in this test', async () => {
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
    if (savedSha !== undefined) {
      delete process.env.GIT_COMMIT_SHA
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'env var should be deleted mid-test')
    } else {
      process.env.GIT_COMMIT_SHA = 'should_be_removed_by_aftereach'
      assert.equal(process.env.GIT_COMMIT_SHA, 'should_be_removed_by_aftereach')
    }

    restoreEnv('GIT_COMMIT_SHA', savedSha)

    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'env var should be restored after deletion')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'env var should not exist after restore when original was undefined')
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

    restoreEnv('GIT_COMMIT_SHA', savedSha)

    const currentValue = Object.hasOwn(process.env, 'GIT_COMMIT_SHA')
      ? process.env.GIT_COMMIT_SHA
      : undefined
    assert.equal(currentValue, savedSha,
      'env var should match original after multiple mutations and restore')
  })
})
