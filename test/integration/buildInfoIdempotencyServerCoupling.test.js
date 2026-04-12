import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { registerBuildInfoRoute } from '../../server/server.js'
import { createApp, listenOnRandomPort } from '../helpers/serverHelper.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'

const ENV_KEY = 'GIT_COMMIT_SHA'

/*
 * CRITICAL TEST — verifies the idempotency guard from issue #327 works
 * correctly across independent server instances and re-registrations.
 */
describe('buildInfo idempotency + server coupling (issue #327)', { timeout: 10000 }, () => {
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

  afterEach(() => restoreEnv(ENV_KEY, savedSha))

  it('guard is per-app: independent instances each serve the route', { timeout: 5000 }, async () => {
    process.env[ENV_KEY] = 'aaaa111122223333444455556666777788889999'

    const [resA, resB] = await Promise.all([
      fetch(`${serverA.baseUrl}/api/build-info`),
      fetch(`${serverB.baseUrl}/api/build-info`),
    ])
    assert.equal(resA.status, 200)
    assert.equal(resB.status, 200)

    const bodyA = await resA.json()
    const bodyB = await resB.json()
    assert.equal(bodyA.commitShort, 'aaaa111')
    assert.equal(bodyB.commitShort, 'aaaa111')

    // A completely separate app instance must accept registration even though appA was already registered
    const app2 = createApp()
    // app2 must NOT have the flag — guard is per-app
    assert.equal(app2.locals._buildInfoRegistered, undefined)
    registerBuildInfoRoute(app2)
    assert.equal(app2.locals._buildInfoRegistered, true)
  })

  it('env is read at request time, not registration time', { timeout: 5000 }, async () => {
    process.env[ENV_KEY] = 'reqtime2222333344445555666677778888999900'
    const res1 = await fetch(`${serverA.baseUrl}/api/build-info`)
    assert.equal((await res1.json()).commitShort, 'reqtime')

    delete process.env[ENV_KEY]
    const res2 = await fetch(`${serverA.baseUrl}/api/build-info`)
    assert.equal((await res2.json()).commitShort, null)

    process.env[ENV_KEY] = 'val_c_33444455556666777788889999000011223333'
    const res3 = await fetch(`${serverA.baseUrl}/api/build-info`)
    assert.equal((await res3.json()).commitShort, 'val_c_3')
  })

  it('re-registration on same app is a silent no-op', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    // Must not throw — this is the "silent" part of issue #327
    assert.doesNotThrow(() => registerBuildInfoRoute(app))
    assert.equal(app.locals._buildInfoRegistered, true)

    const layers = app._router.stack.filter(
      (l) => l.route && l.route.path === '/api/build-info'
    )
    assert.equal(layers.length, 1)

    const server = await listenOnRandomPort(app)
    try {
      process.env[ENV_KEY] = 'noop1111222233334444555566667777888899aa'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      assert.equal((await res.json()).commitShort, 'noop111')
    } finally {
      await server.close()
    }
  })
})
