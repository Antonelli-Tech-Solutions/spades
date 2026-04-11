/**
 * Tests for GitHub issue #335: Redundant after-hook env restoration.
 *
 * buildInfoIdempotency.test.js has three layers of env cleanup:
 *   1. try/finally in each test that mutates env vars
 *   2. afterEach hook restoring env vars after every test
 *   3. after hook restoring env vars after the entire suite
 *
 * Layer 3 (after) is redundant because afterEach already runs after the last
 * test. These tests prove that afterEach alone is sufficient and the after
 * hook only needs to handle server teardown.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

describe('after-hook env restoration is redundant (issue #335)', { timeout: 10000 }, () => {
  let server
  let baseUrl
  const savedSha = saveEnv('GIT_COMMIT_SHA')

  /** Track cleanup calls to verify ordering and coverage. */
  let afterEachCallCount = 0
  let afterCallCount = 0

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
    afterCallCount++
    // Only server teardown here — no env restoration
    await new Promise((res) => server.close(res))
  })

  afterEach(() => {
    afterEachCallCount++
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  it('afterEach restores env var after a test mutates it without try/finally', async () => {
    // Deliberately set env var and do NOT clean up — rely on afterEach
    process.env.GIT_COMMIT_SHA = 'dirty_1234567890abcdef1234567890abcdef1234'

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    assert.equal((await res.json()).commitShort, 'dirty_1')
    // afterEach will fire after this test and restore the env var
  })

  it('env var is clean after previous test relied solely on afterEach', () => {
    // Proves afterEach from the previous test actually ran
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should have restored original value after previous test')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'afterEach should have deleted env var after previous test')
    }
    assert.equal(afterEachCallCount, 1,
      'afterEach should have been called once (after the first test)')
  })

  it('try/finally provides immediate cleanup before afterEach even runs', async () => {
    const envBefore = saveEnv('GIT_COMMIT_SHA')
    try {
      process.env.GIT_COMMIT_SHA = 'tryfinally1234567890abcdef1234567890abcd'

      const res = await fetch(`${baseUrl}/api/build-info`)
      assert.equal((await res.json()).commitShort, 'tryfina')
    } finally {
      restoreEnv('GIT_COMMIT_SHA', envBefore)
    }

    // Env is already restored before afterEach runs
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false)
    }
  })

  it('afterEach runs after every test including the last one', () => {
    // At this point, 3 previous tests have completed
    assert.equal(afterEachCallCount, 3,
      'afterEach should have run after each of the 3 preceding tests')
    // The after hook has NOT run yet — it only fires after all tests
    assert.equal(afterCallCount, 0,
      'after hook should not have fired yet (suite is not finished)')
  })
})

describe('after-hook only needed for server teardown (issue #335)', { timeout: 10000 }, () => {
  let server
  let baseUrl
  const savedSha = saveEnv('GIT_COMMIT_SHA')
  let afterEachRanForLastTest = false

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
    // Verify afterEach ran for the last test before after fires
    assert.equal(afterEachRanForLastTest, true,
      'afterEach must run for the last test before the after hook — env cleanup in after is redundant')
    await new Promise((res) => server.close(res))
  })

  afterEach(() => {
    restoreEnv('GIT_COMMIT_SHA', savedSha)
    afterEachRanForLastTest = true
  })

  it('mutates env var in the only/last test — afterEach will clean up before after runs', async () => {
    process.env.GIT_COMMIT_SHA = 'lasttest1234567890abcdef1234567890abcdef'

    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    assert.equal((await res.json()).commitShort, 'lasttes')
    // afterEach will restore env BEFORE the after hook fires
  })
})

describe('triple cleanup vs double cleanup produces identical results (issue #335)', { timeout: 10000 }, () => {
  const savedSha = saveEnv('GIT_COMMIT_SHA')
  let server
  let baseUrl

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
    await new Promise((res) => server.close(res))
    // Deliberately NO env restoration in after hook — proving it's not needed
  })

  afterEach(() => {
    restoreEnv('GIT_COMMIT_SHA', savedSha)
  })

  it('test with try/finally + afterEach (no after env cleanup) — env is clean', async () => {
    try {
      process.env.GIT_COMMIT_SHA = 'double_1234567890abcdef1234567890abcdef12'
      const res = await fetch(`${baseUrl}/api/build-info`)
      assert.equal((await res.json()).commitShort, 'double_')
    } finally {
      restoreEnv('GIT_COMMIT_SHA', savedSha)
    }
  })

  it('env var is clean without after-hook env restoration', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'env var should be restored by afterEach alone — after hook env cleanup is unnecessary')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'env var should be deleted by afterEach alone — after hook env cleanup is unnecessary')
    }
  })

  it('test with only afterEach cleanup (no try/finally, no after) — env is still clean', async () => {
    process.env.GIT_COMMIT_SHA = 'onlyae_1234567890abcdef1234567890abcdef12'
    const res = await fetch(`${baseUrl}/api/build-info`)
    assert.equal((await res.json()).commitShort, 'onlyae_')
    // No try/finally — afterEach is the sole safety net
  })

  it('env var is clean after test that relied only on afterEach', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach alone is sufficient for env cleanup')
    } else {
      assert.equal(Object.hasOwn(process.env, 'GIT_COMMIT_SHA'), false,
        'afterEach alone is sufficient for env cleanup')
    }
  })
})
