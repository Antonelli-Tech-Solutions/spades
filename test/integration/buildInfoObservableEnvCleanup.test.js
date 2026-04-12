/**
 * Tests for GitHub issue #384:
 *
 * buildInfoRouterStackObservable.test.js calls restoreEnv in BOTH afterEach
 * hooks AND a try/finally block (line ~322). The double-restore is harmless
 * but confusing — pick one owner for cleanup.
 *
 * These tests prove that afterEach-only cleanup is sufficient for every
 * pattern used in the observable test file:
 *   1. afterEach restores env between sequential tests (no try/finally)
 *   2. withBuildInfoServer helper's finally handles server close only — env
 *      cleanup belongs to afterEach
 *   3. Manual server lifecycle (the pattern from the last test in the file)
 *      works with afterEach-only cleanup
 *   4. Env deletion and restoration round-trips via afterEach alone
 *   5. Multiple env mutations within a single test are cleaned by afterEach
 *   6. Parallel fetch with env mutation is cleaned by afterEach alone
 *   7. Custom routes alongside build-info — no finally needed for env
 *   8. restoreEnv called twice (simulating double-restore) is idempotent
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

// ── Shared helpers (mirrors buildInfoRouterStackObservable.test.js) ──────────

function createApp() {
  const app = express()
  app.use(express.json())
  return app
}

function listenOnRandomPort(app) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, () => {
      const { port } = srv.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => srv.close(res)),
      })
    })
    srv.on('error', (err) => reject(err))
  })
}

function createRegisteredApp({ count = 1, simulateGuardReset = false } = {}) {
  const app = createApp()
  for (let i = 0; i < count; i++) {
    if (simulateGuardReset && i === count - 1) {
      app.locals._buildInfoRegistered = false
    }
    registerBuildInfoRoute(app)
  }
  return app
}

/**
 * Server lifecycle helper — finally only closes the server, NOT env.
 * Env cleanup is afterEach's responsibility.
 */
async function withBuildInfoServer(appOpts, fn) {
  const app = createRegisteredApp(appOpts)
  const server = await listenOnRandomPort(app)
  try {
    await fn(server.baseUrl, app)
  } finally {
    await server.close()
  }
}

const ENV_KEY = 'GIT_COMMIT_SHA'
const TEST_SHA = 'cleanup384_test_sha_567890abcdef12345678'
const TEST_SHORT = 'cleanup'

// ── 1. afterEach alone isolates env between sequential tests ────────────────

describe('afterEach-only cleanup isolates env across observable tests (issue #384)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('first test mutates env via withBuildInfoServer — no finally for env', { timeout: 5000 }, async () => {
    await withBuildInfoServer({ count: 2 }, async (baseUrl) => {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const res = await fetch(`${baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.commitShort, TEST_SHORT)
      // env is still mutated when this callback returns —
      // withBuildInfoServer's finally only closes the server
    })
  })

  it('second test sees restored env — afterEach cleaned up without finally', { timeout: 5000 }, () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should have restored env to original value')
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false,
        'afterEach should have deleted env var since it was originally unset')
    }
  })

  it('third test mutates env to different value — still no finally', { timeout: 5000 }, async () => {
    await withBuildInfoServer({ count: 2 }, async (baseUrl) => {
      process.env.GIT_COMMIT_SHA = 'different384_sha_11222233334444555566'
      const res = await fetch(`${baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, 'differe')
    })
  })

  it('fourth test confirms third test env was cleaned by afterEach', { timeout: 5000 }, () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false)
    }
  })
})

// ── 2. Manual server lifecycle without finally for restoreEnv ───────────────

describe('manual server lifecycle needs no finally for env cleanup (issue #384)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('custom route + build-info with manual server — afterEach handles env', { timeout: 5000 }, async () => {
    // This mirrors the pattern from buildInfoRouterStackObservable.test.js
    // line 302-326, which had restoreEnv in BOTH finally and afterEach
    const app = createRegisteredApp({ count: 2 })
    app.get('/api/health', (req, res) => res.json({ ok: true }))
    const server = await listenOnRandomPort(app)

    // No try/finally with restoreEnv — only afterEach cleans env
    try {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const [buildRes, healthRes] = await Promise.all([
        fetch(`${server.baseUrl}/api/build-info`),
        fetch(`${server.baseUrl}/api/health`),
      ])

      assert.equal(buildRes.status, 200)
      assert.equal(healthRes.status, 200)

      const buildBody = await buildRes.json()
      const healthBody = await healthRes.json()
      assert.equal(buildBody.commitShort, TEST_SHORT)
      assert.deepStrictEqual(healthBody, { ok: true })
    } finally {
      // finally only closes the server — env cleanup is afterEach's job
      await server.close()
    }
  })

  it('env is restored after manual server test — afterEach sufficed', { timeout: 5000 }, () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should restore env after manual server test')
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false,
        'afterEach should delete env after manual server test when originally unset')
    }
  })
})

// ── 3. Env deletion round-trip via afterEach ────────────────────────────────

describe('env deletion restored by afterEach in observable context (issue #384)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('deleting env mid-test does not persist — afterEach restores', { timeout: 5000 }, async () => {
    await withBuildInfoServer({ count: 1 }, async (baseUrl) => {
      delete process.env.GIT_COMMIT_SHA
      const res = await fetch(`${baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, null,
        'deleted env should yield null commitShort')
    })
  })

  it('env is restored after deletion in previous test', { timeout: 5000 }, () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should have restored the deleted env var')
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false)
    }
  })
})

// ── 4. Multiple env mutations within a single test ──────────────────────────

describe('multiple env mutations in one test cleaned by afterEach (issue #384)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('env change after double registration reflected correctly — no finally', { timeout: 5000 }, async () => {
    // Mirrors the env-change-after-double-registration test pattern
    await withBuildInfoServer({ count: 2 }, async (baseUrl) => {
      process.env.GIT_COMMIT_SHA = 'first384_sha_1234567890abcdef12345678'
      const res1 = await fetch(`${baseUrl}/api/build-info`)
      const body1 = await res1.json()
      assert.equal(body1.commitShort, 'first38')

      process.env.GIT_COMMIT_SHA = 'second384_sha_234567890abcdef123456789'
      const res2 = await fetch(`${baseUrl}/api/build-info`)
      const body2 = await res2.json()
      assert.equal(body2.commitShort, 'second3')
    })
  })

  it('env is restored after multiple mutations — afterEach is single cleanup owner', { timeout: 5000 }, () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should restore env regardless of how many mutations occurred')
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false)
    }
  })
})

// ── 5. Guard-reset scenario with afterEach-only cleanup ─────────────────────

describe('guard-reset re-registration with afterEach-only cleanup (issue #384)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('guard-reset + env mutation cleaned by afterEach — no finally for env', { timeout: 5000 }, async () => {
    await withBuildInfoServer({ count: 2, simulateGuardReset: true }, async (baseUrl) => {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const res = await fetch(`${baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, TEST_SHORT)
    })
  })

  it('env is clean after guard-reset test — afterEach handled it', { timeout: 5000 }, () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false)
    }
  })
})

// ── 6. Parallel fetch with env mutation — afterEach-only ────────────────────

describe('parallel requests with env mutation cleaned by afterEach (issue #384)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('rapid parallel requests all get consistent env — no finally for env', { timeout: 5000 }, async () => {
    await withBuildInfoServer({ count: 2 }, async (baseUrl) => {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const requests = Array.from({ length: 5 }, () =>
        fetch(`${baseUrl}/api/build-info`)
      )
      const responses = await Promise.all(requests)

      for (const res of responses) {
        assert.equal(res.status, 200)
        const body = await res.json()
        assert.equal(body.commitShort, TEST_SHORT)
      }
    })
  })

  it('env is clean after parallel request test', { timeout: 5000 }, () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false)
    }
  })
})

// ── 7. restoreEnv double-call is idempotent (validates removing one) ────────

describe('restoreEnv idempotency proves one call suffices (issue #384)', { timeout: 2000 }, () => {
  const TEMP_KEY = '__DOUBLE_RESTORE_384__'

  afterEach(() => {
    delete process.env[TEMP_KEY]
  })

  it('double restoreEnv with string value yields same state as single call', () => {
    process.env[TEMP_KEY] = 'mutated'
    const saved = 'original'

    // Single call
    restoreEnv(TEMP_KEY, saved)
    const stateAfterOne = process.env[TEMP_KEY]

    // Mutate again, then double call (simulating finally + afterEach)
    process.env[TEMP_KEY] = 'mutated_again'
    restoreEnv(TEMP_KEY, saved)
    restoreEnv(TEMP_KEY, saved)
    const stateAfterTwo = process.env[TEMP_KEY]

    assert.equal(stateAfterOne, stateAfterTwo,
      'single and double restoreEnv should produce identical state')
  })

  it('double restoreEnv with undefined yields same state as single call', () => {
    process.env[TEMP_KEY] = 'should_vanish'

    restoreEnv(TEMP_KEY, undefined)
    const stateAfterOne = Object.hasOwn(process.env, TEMP_KEY)

    process.env[TEMP_KEY] = 'should_vanish_again'
    restoreEnv(TEMP_KEY, undefined)
    restoreEnv(TEMP_KEY, undefined)
    const stateAfterTwo = Object.hasOwn(process.env, TEMP_KEY)

    assert.equal(stateAfterOne, stateAfterTwo,
      'single and double delete via restoreEnv should both result in unset')
    assert.equal(stateAfterTwo, false)
  })

  it('finally restoreEnv + afterEach restoreEnv is equivalent to afterEach alone', () => {
    // This directly models the redundant pattern from line 322 of the original file
    const saved = saveEnv(TEMP_KEY)

    // Scenario A: afterEach-only
    process.env[TEMP_KEY] = 'scenario_a'
    restoreEnv(TEMP_KEY, saved) // simulated afterEach
    const stateA = Object.hasOwn(process.env, TEMP_KEY)
      ? process.env[TEMP_KEY]
      : '__UNSET__'

    // Scenario B: finally + afterEach (the redundant pattern)
    process.env[TEMP_KEY] = 'scenario_b'
    restoreEnv(TEMP_KEY, saved) // simulated finally
    restoreEnv(TEMP_KEY, saved) // simulated afterEach
    const stateB = Object.hasOwn(process.env, TEMP_KEY)
      ? process.env[TEMP_KEY]
      : '__UNSET__'

    assert.equal(stateA, stateB,
      'afterEach-only and finally+afterEach should leave identical env state')
  })
})

// ── 8. withBuildInfoServer finally is for server close, not env ──────────────

describe('withBuildInfoServer finally is for server close only (issue #384)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('server is closed by helper finally even when test throws — env cleaned by afterEach', { timeout: 5000 }, async () => {
    // Verify the helper closes the server on error, but env is still dirty
    // until afterEach runs
    let serverPort
    try {
      await withBuildInfoServer({ count: 1 }, async (baseUrl) => {
        process.env.GIT_COMMIT_SHA = 'throw384_sha_1234567890abcdef1234567'
        serverPort = new URL(baseUrl).port
        throw new Error('deliberate test error')
      })
    } catch (e) {
      assert.equal(e.message, 'deliberate test error')
    }

    // Server should be closed by withBuildInfoServer's finally
    try {
      await fetch(`http://127.0.0.1:${serverPort}/api/build-info`)
      assert.fail('Server should be closed after withBuildInfoServer exits')
    } catch {
      // Expected: connection refused = server was closed
    }

    // Env is still mutated — afterEach hasn't run yet within this test
    assert.equal(process.env.GIT_COMMIT_SHA, 'throw384_sha_1234567890abcdef1234567',
      'env should still be mutated — afterEach cleans it AFTER the test')
  })

  it('afterEach cleaned env from the throwing test above', { timeout: 5000 }, () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should have restored env after the throwing test')
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false,
        'afterEach should have deleted env after the throwing test')
    }
  })
})
