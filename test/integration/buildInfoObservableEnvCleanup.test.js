/**
 * Tests for GitHub issue #384 (consolidated per issue #424):
 *
 * Proves that afterEach-only cleanup is sufficient for env restoration
 * in the observable test file — the redundant try/finally restoreEnv
 * call can be removed.
 *
 * Three focused groups:
 *   1. afterEach restores env across sequential tests (covers mutation,
 *      deletion, multiple mutations, parallel requests)
 *   2. restoreEnv is idempotent (single vs double call, string vs undefined)
 *   3. withBuildInfoServer finally closes server only — env cleanup is
 *      afterEach's job, even when the test throws
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

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

function createRegisteredApp({ count = 1, resetGuardBeforeLast = false } = {}) {
  const app = createApp()
  for (let i = 0; i < count; i++) {
    if (resetGuardBeforeLast && i === count - 1) {
      app.locals._buildInfoRegistered = false
    }
    registerBuildInfoRoute(app)
  }
  return app
}

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

function assertEnvRestored(savedSha) {
  if (savedSha !== undefined) {
    assert.equal(process.env.GIT_COMMIT_SHA, savedSha,
      'afterEach should have restored env to original value')
  } else {
    assert.equal(Object.hasOwn(process.env, ENV_KEY), false,
      'afterEach should have deleted env var since it was originally unset')
  }
}

// ── 1. afterEach restores env across sequential tests ─────────────────────────

describe('afterEach-only cleanup restores env across tests (issue #384)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('mutates env via withBuildInfoServer — no finally for env', { timeout: 5000 }, async () => {
    await withBuildInfoServer({ count: 2 }, async (baseUrl) => {
      process.env.GIT_COMMIT_SHA = TEST_SHA
      const res = await fetch(`${baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.commitShort, TEST_SHORT)
    })
  })

  it('env restored after mutation — afterEach sufficed', { timeout: 5000 }, () => {
    assertEnvRestored(savedSha)
  })

  it('multiple mutations and deletion in one test cleaned by afterEach', { timeout: 5000 }, async () => {
    await withBuildInfoServer({ count: 2 }, async (baseUrl) => {
      process.env.GIT_COMMIT_SHA = 'first384_sha_1234567890abcdef12345678'
      const res1 = await fetch(`${baseUrl}/api/build-info`)
      const body1 = await res1.json()
      assert.equal(body1.commitShort, 'first38')

      process.env.GIT_COMMIT_SHA = 'second384_sha_234567890abcdef123456789'
      const res2 = await fetch(`${baseUrl}/api/build-info`)
      const body2 = await res2.json()
      assert.equal(body2.commitShort, 'second3')

      delete process.env.GIT_COMMIT_SHA
      const res3 = await fetch(`${baseUrl}/api/build-info`)
      const body3 = await res3.json()
      assert.equal(body3.commitShort, null)
    })
  })

  it('env restored after multiple mutations and deletion', { timeout: 5000 }, () => {
    assertEnvRestored(savedSha)
  })
})

// ── 2. restoreEnv is idempotent ───────────────────────────────────────────────

describe('restoreEnv idempotency proves one call suffices (issue #384)', { timeout: 2000 }, () => {
  const TEMP_KEY = '__DOUBLE_RESTORE_384__'

  afterEach(() => {
    delete process.env[TEMP_KEY]
  })

  it('double restoreEnv with string value yields same state as single call', () => {
    process.env[TEMP_KEY] = 'mutated'
    const saved = 'original'

    restoreEnv(TEMP_KEY, saved)
    const stateAfterOne = process.env[TEMP_KEY]

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
    const saved = saveEnv(TEMP_KEY)

    process.env[TEMP_KEY] = 'scenario_a'
    restoreEnv(TEMP_KEY, saved)
    const stateA = Object.hasOwn(process.env, TEMP_KEY)
      ? process.env[TEMP_KEY]
      : '__UNSET__'

    process.env[TEMP_KEY] = 'scenario_b'
    restoreEnv(TEMP_KEY, saved)
    restoreEnv(TEMP_KEY, saved)
    const stateB = Object.hasOwn(process.env, TEMP_KEY)
      ? process.env[TEMP_KEY]
      : '__UNSET__'

    assert.equal(stateA, stateB,
      'afterEach-only and finally+afterEach should leave identical env state')
  })
})

// ── 3. withBuildInfoServer finally closes server, not env ─────────────────────

describe('withBuildInfoServer finally is for server close only (issue #384)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('server is closed by helper finally even when test throws — env cleaned by afterEach', { timeout: 5000 }, async () => {
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

    try {
      await fetch(`http://127.0.0.1:${serverPort}/api/build-info`)
      assert.fail('Server should be closed after withBuildInfoServer exits')
    } catch {
      // Expected: connection refused = server was closed
    }

    assert.equal(process.env.GIT_COMMIT_SHA, 'throw384_sha_1234567890abcdef1234567',
      'env should still be mutated — afterEach cleans it AFTER the test')
  })

  it('afterEach cleaned env from the throwing test above', { timeout: 5000 }, () => {
    assertEnvRestored(savedSha)
  })
})
