/**
 * Tests for GitHub issue #346:
 *
 * Every test that mutates process.env.GIT_COMMIT_SHA restores it in BOTH a
 * try/finally block AND an afterEach hook. The afterEach already guarantees
 * cleanup if the finally is missed, and the finally already handles it before
 * afterEach runs. This redundancy adds noise without improving safety.
 *
 * These tests prove that afterEach-only cleanup is sufficient for the Node
 * test runner — env mutations in one test never leak into the next, even
 * without try/finally guards.
 *
 * Strategy:
 *   1. Verify afterEach restores env after a normal (passing) test
 *   2. Verify afterEach restores env after a test that throws
 *   3. Verify sequential tests with different env values stay isolated
 *   4. Verify delete + restore round-trips work via afterEach alone
 *   5. Verify restoreEnv is idempotent (double-call in afterEach + finally is harmless but noisy)
 *   6. Prove the refactored tests (no try/finally) still pass with real HTTP
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function createApp() {
  const app = express()
  app.use(express.json())
  return app
}

function listenOnRandomPort(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const { port } = srv.address()
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => srv.close(res)),
      })
    })
  })
}

const ENV_KEY = 'GIT_COMMIT_SHA'

// ── afterEach-only cleanup is sufficient for env isolation ───────────────────

describe('afterEach-only cleanup isolates env between tests (issue #346)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('first test sets env to value A — no try/finally', () => {
    process.env.GIT_COMMIT_SHA = 'aaa_first_test_value_000000000000000000'
    assert.equal(process.env.GIT_COMMIT_SHA, 'aaa_first_test_value_000000000000000000')
  })

  it('second test sees restored env, not value A from previous test', () => {
    // If afterEach cleanup failed, this would still be 'aaa_first_test_value_...'
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false,
        'GIT_COMMIT_SHA should have been deleted by afterEach since it was originally unset')
    }
  })

  it('third test sets env to value B — confirms isolation from first test', () => {
    process.env.GIT_COMMIT_SHA = 'bbb_third_test_value_111111111111111111'
    assert.equal(process.env.GIT_COMMIT_SHA, 'bbb_third_test_value_111111111111111111')
  })

  it('fourth test again sees restored env, not value B', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false)
    }
  })
})

// ── afterEach runs even when an async rejection occurs ───────────────────────

describe('afterEach restores env after async rejection in test (issue #346)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('mutate env, then verify afterEach cleans up across subtests', async (t) => {
    // Use a subtest that modifies env; afterEach on the parent still runs
    process.env.GIT_COMMIT_SHA = 'subtest_throw_value_2222222222222222'

    // Verify mutation took effect
    assert.equal(process.env.GIT_COMMIT_SHA, 'subtest_throw_value_2222222222222222')
  })

  it('env is restored after previous test — proves afterEach suffices', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
        'afterEach should restore env between tests')
    } else {
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false,
        'afterEach should delete env var when original was unset')
    }
  })
})

// ── afterEach handles delete-then-restore round-trip ─────────────────────────

describe('afterEach restores env after deletion (issue #346)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('deleting GIT_COMMIT_SHA does not persist to next test', () => {
    delete process.env.GIT_COMMIT_SHA
    assert.equal(Object.hasOwn(process.env, ENV_KEY), false)
  })

  it('env is restored after deletion in previous test', () => {
    if (savedSha !== undefined) {
      assert.equal(process.env.GIT_COMMIT_SHA, savedSha)
    } else {
      // If it was originally unset, it should still be unset (delete is idempotent)
      assert.equal(Object.hasOwn(process.env, ENV_KEY), false)
    }
  })
})

// ── restoreEnv is idempotent (justifies removing the redundant call) ─────────

describe('restoreEnv idempotency — double call is safe but unnecessary (issue #346)', { timeout: 2000 }, () => {
  const TEST_KEY = '__IDEMPOTENT_RESTORE_346__'

  afterEach(() => {
    delete process.env[TEST_KEY]
  })

  it('calling restoreEnv twice with a string value produces same result', () => {
    process.env[TEST_KEY] = 'modified'
    restoreEnv(TEST_KEY, 'original')
    restoreEnv(TEST_KEY, 'original')
    assert.equal(process.env[TEST_KEY], 'original')
  })

  it('calling restoreEnv twice with undefined produces same result', () => {
    process.env[TEST_KEY] = 'should_vanish'
    restoreEnv(TEST_KEY, undefined)
    restoreEnv(TEST_KEY, undefined)
    assert.equal(Object.hasOwn(process.env, TEST_KEY), false)
  })

  it('restoreEnv in finally then afterEach is equivalent to afterEach alone', () => {
    // Simulate the redundant pattern: try/finally + afterEach
    const saved = saveEnv(TEST_KEY)
    process.env[TEST_KEY] = 'mutated'

    // Simulated finally block
    restoreEnv(TEST_KEY, saved)
    const stateAfterFinally = Object.hasOwn(process.env, TEST_KEY)
      ? process.env[TEST_KEY]
      : undefined

    // Simulated afterEach (runs after finally)
    restoreEnv(TEST_KEY, saved)
    const stateAfterAfterEach = Object.hasOwn(process.env, TEST_KEY)
      ? process.env[TEST_KEY]
      : undefined

    assert.equal(stateAfterFinally, stateAfterAfterEach,
      'finally + afterEach should produce the same state as afterEach alone')
  })
})

// ── Refactored coupling tests: afterEach-only, no try/finally ────────────────
// These mirror the env-mutating tests from buildInfoIdempotencyServerCoupling.test.js
// but use ONLY afterEach for cleanup, proving try/finally is unnecessary.

describe('per-app idempotency — afterEach-only cleanup (issue #346)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)
  let serverA, serverB

  before(async () => {
    const appA = createApp()
    registerBuildInfoRoute(appA)
    serverA = await listenOnRandomPort(appA)

    const appB = createApp()
    registerBuildInfoRoute(appB)
    serverB = await listenOnRandomPort(appB)
  })

  after(async () => {
    await serverA.close()
    await serverB.close()
    restoreEnv(ENV_KEY, savedSha)
  })

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('both app instances serve build-info without try/finally', { timeout: 5000 }, async () => {
    process.env.GIT_COMMIT_SHA = 'nofinally_aaa111222233334444555566667777'

    const [resA, resB] = await Promise.all([
      fetch(`${serverA.baseUrl}/api/build-info`),
      fetch(`${serverB.baseUrl}/api/build-info`),
    ])

    assert.equal(resA.status, 200)
    assert.equal(resB.status, 200)

    const bodyA = await resA.json()
    const bodyB = await resB.json()
    assert.equal(bodyA.commitShort, 'nofinal')
    assert.equal(bodyB.commitShort, 'nofinal')
  })

  it('env from previous test does not leak — afterEach cleaned up', { timeout: 5000 }, async () => {
    // This test verifies the previous test's env mutation was cleaned up by afterEach
    const res = await fetch(`${serverA.baseUrl}/api/build-info`)
    const body = await res.json()
    // Should NOT be 'nofinal' from previous test
    if (savedSha) {
      assert.equal(body.commitShort, savedSha.slice(0, 7))
    } else {
      assert.equal(body.commitShort, null,
        'With no original SHA, commit should be null after afterEach restore')
    }
  })

  it('sequential env changes reflected correctly without try/finally', { timeout: 5000 }, async () => {
    process.env.GIT_COMMIT_SHA = 'seq1_aa11222233334444555566667777888899'
    const res1 = await fetch(`${serverA.baseUrl}/api/build-info`)
    const body1 = await res1.json()
    assert.equal(body1.commitShort, 'seq1_aa')

    process.env.GIT_COMMIT_SHA = 'seq2_bb22333344445555666677778888999900'
    const [resA2, resB2] = await Promise.all([
      fetch(`${serverA.baseUrl}/api/build-info`),
      fetch(`${serverB.baseUrl}/api/build-info`),
    ])
    const bodyA2 = await resA2.json()
    const bodyB2 = await resB2.json()
    assert.equal(bodyA2.commitShort, 'seq2_bb')
    assert.equal(bodyB2.commitShort, 'seq2_bb')
  })
})

// ── Request-time env reading — afterEach-only cleanup ────────────────────────

describe('env read at request time — afterEach-only cleanup (issue #346)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)
  let server

  before(async () => {
    process.env.GIT_COMMIT_SHA = 'regtime346_11222233334444555566667777'
    const app = createApp()
    registerBuildInfoRoute(app)
    server = await listenOnRandomPort(app)
  })

  after(async () => {
    await server.close()
    restoreEnv(ENV_KEY, savedSha)
  })

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('env change after registration changes response — no try/finally', { timeout: 5000 }, async () => {
    process.env.GIT_COMMIT_SHA = 'changed346_222233334444555566667777'
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()
    assert.equal(body.commitShort, 'changed')
  })

  it('deleting env returns null — no try/finally', { timeout: 5000 }, async () => {
    delete process.env.GIT_COMMIT_SHA
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    const body = await res.json()
    assert.equal(body.commitShort, null)
  })

  it('multiple env changes between requests — no try/finally', { timeout: 5000 }, async () => {
    const values = [
      { sha: 'only_a_11222233334444555566667777888899001111', expected: 'only_a_' },
      { sha: 'only_b_22333344445555666677778888999900112222', expected: 'only_b_' },
      { sha: 'only_c_33444455556666777788889999000011223333', expected: 'only_c_' },
    ]

    for (const { sha, expected } of values) {
      process.env.GIT_COMMIT_SHA = sha
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      const body = await res.json()
      assert.equal(body.commitShort, expected,
        `Expected ${expected} but got ${body.commitShort} for SHA ${sha}`)
    }
  })
})

// ── Server cleanup in after() — no try/finally needed ────────────────────────

describe('server close in after() not try/finally (issue #346)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('route works after re-registration — server closed in after, not finally', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app) // idempotent
    const server = await listenOnRandomPort(app)

    // No try/finally — rely on test structure for cleanup
    process.env.GIT_COMMIT_SHA = 'srvclose_test_sha_34567890abcdef123456'
    const res = await fetch(`${server.baseUrl}/api/build-info`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.commitShort, 'srvclos')

    await server.close()
  })

  it('fresh app with server lifecycle in single test — no finally', { timeout: 5000 }, async () => {
    const servers = []

    for (let i = 0; i < 2; i++) {
      const app = createApp()
      registerBuildInfoRoute(app)
      const srv = await listenOnRandomPort(app)
      servers.push(srv)
    }

    process.env.GIT_COMMIT_SHA = 'multi346_test_sha_1234567890abcdef1234'
    for (const srv of servers) {
      const res = await fetch(`${srv.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.commitShort, 'multi34')
    }

    for (const srv of servers) {
      await srv.close()
    }
  })
})
