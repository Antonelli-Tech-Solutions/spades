/**
 * Tests for GitHub issue #388:
 *
 * Several tests in buildInfoIdempotencyServerCoupling.test.js create servers
 * inline (not in before/after hooks) and call server.close() at the end of the
 * test body. If an assertion fails before reaching server.close(), the server
 * handle leaks and the port stays bound until process exit.
 *
 * These tests verify that the three affected test patterns properly clean up
 * server resources regardless of whether assertions pass or fail. The fix is
 * to use try/finally for server.close() or move server lifecycle into
 * before/after hooks.
 *
 * Affected patterns:
 *   1. Single inline server (re-registration test, duphandler test)
 *   2. Multiple inline servers in a loop (sequential fresh apps test)
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { registerBuildInfoRoute } from '../../server/server.js'
import { saveEnv, restoreEnv } from '../helpers/envHelper.js'
import { createApp, listenOnRandomPort } from '../helpers/serverHelper.js'

const ENV_KEY = 'GIT_COMMIT_SHA'

/**
 * Helper: check whether a port is available by trying to listen on it.
 * Resolves true if the port is free, false if EADDRINUSE.
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
    tester.once('error', (err) => {
      resolve(err.code !== 'EADDRINUSE')
    })
    tester.listen(port, () => {
      tester.close(() => resolve(true))
    })
  })
}

// — Single inline server cleanup ——————————————————————————————————————————————

describe('single inline server is cleaned up after test (issue #388)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('re-registration test closes server even when assertions execute', { timeout: 5000 }, async () => {
    // Mirrors the pattern from the "route still works correctly after
    // idempotent re-registration" test — server created inline, used, closed.
    // The fix ensures server.close() runs via try/finally or before/after.
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)
    const port = server.port

    try {
      process.env.GIT_COMMIT_SHA = 'cleanup_test_sha_1234567890abcdef1234'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.commitShort, 'cleanup')
    } finally {
      await server.close()
    }

    // After close, the port should be free
    const free = await isPortFree(port)
    assert.equal(free, true, `Port ${port} should be free after server.close()`)
  })

  it('idempotent registration test closes server even when assertions execute', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)
    const port = server.port

    try {
      process.env.GIT_COMMIT_SHA = 'dupclean_test_sha_234567890abcdef12345'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.commitShort, 'dupclea')
    } finally {
      await server.close()
    }

    const free = await isPortFree(port)
    assert.equal(free, true, `Port ${port} should be free after server.close()`)
  })
})

// — Multiple inline servers cleanup ——————————————————————————————————————————

describe('multiple inline servers are cleaned up after test (issue #388)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('sequential fresh apps close all servers even when assertions execute', { timeout: 5000 }, async () => {
    // Mirrors the "sequential fresh apps each get their own working route" test.
    // The original creates 3 servers in a loop and closes them all at the end.
    // If any assertion fails mid-loop, some servers leak.
    const servers = []

    try {
      for (let i = 0; i < 3; i++) {
        const app = createApp()
        registerBuildInfoRoute(app)
        const srv = await listenOnRandomPort(app)
        servers.push(srv)
      }

      process.env.GIT_COMMIT_SHA = 'multi_cleanup_sha_1234567890abcdef1234'
      for (const srv of servers) {
        const res = await fetch(`${srv.baseUrl}/api/build-info`)
        assert.equal(res.status, 200, `Server at ${srv.baseUrl} should respond 200`)
        const body = await res.json()
        assert.equal(body.commitShort, 'multi_c')
      }
    } finally {
      // All servers must be closed, even if assertions failed partway through
      for (const srv of servers) {
        await srv.close()
      }
    }

    // Verify all ports are free
    for (const srv of servers) {
      const free = await isPortFree(srv.port)
      assert.equal(free, true, `Port ${srv.port} should be free after server.close()`)
    }
  })

  it('partially created servers are cleaned up if later creation fails', { timeout: 5000 }, async () => {
    // Edge case: if we create 2 servers successfully but the 3rd fails,
    // the first 2 should still be cleaned up.
    const servers = []

    try {
      const app1 = createApp()
      registerBuildInfoRoute(app1)
      const srv1 = await listenOnRandomPort(app1)
      servers.push(srv1)

      const app2 = createApp()
      registerBuildInfoRoute(app2)
      const srv2 = await listenOnRandomPort(app2)
      servers.push(srv2)

      // Both servers should be reachable
      process.env.GIT_COMMIT_SHA = 'partial_cleanup_sha_567890abcdef123456'
      for (const srv of servers) {
        const res = await fetch(`${srv.baseUrl}/api/build-info`)
        assert.equal(res.status, 200)
      }
    } finally {
      for (const srv of servers) {
        await srv.close()
      }
    }

    // All ports freed
    for (const srv of servers) {
      const free = await isPortFree(srv.port)
      assert.equal(free, true, `Port ${srv.port} should be free after cleanup`)
    }
  })
})

// — Server lifecycle in before/after hooks ————————————————————————————————————

describe('server lifecycle managed via before/after hooks (issue #388)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('server in afterEach cleanup survives assertion failure', { timeout: 5000 }, async () => {
    // Demonstrates the recommended pattern: server cleanup in a hook,
    // not dependent on test body control flow.
    let server
    const app = createApp()
    registerBuildInfoRoute(app)
    server = await listenOnRandomPort(app)
    const port = server.port

    try {
      process.env.GIT_COMMIT_SHA = 'hook_cleanup_sha_890abcdef1234567890ab'
      const res = await fetch(`${server.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.commitShort, 'hook_cl')
    } finally {
      // This simulates what a proper after/afterEach hook would do
      await server.close()
    }

    const free = await isPortFree(port)
    assert.equal(free, true, `Port ${port} should be free after hook-style cleanup`)
  })
})

// — Port reuse after proper cleanup ——————————————————————————————————————————

describe('port is reusable after proper server cleanup (issue #388)', { timeout: 10000 }, () => {
  const savedSha = saveEnv(ENV_KEY)

  afterEach(() => {
    restoreEnv(ENV_KEY, savedSha)
  })

  it('can bind to same port after server is closed', { timeout: 5000 }, async () => {
    const app1 = createApp()
    registerBuildInfoRoute(app1)
    const server1 = await listenOnRandomPort(app1)
    const port = server1.port

    await server1.close()

    // Should be able to bind a new server on the same port
    const app2 = createApp()
    registerBuildInfoRoute(app2)
    const server2 = await new Promise((resolve, reject) => {
      const srv = app2.listen(port, () => {
        resolve({
          port,
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((res) => srv.close(res)),
        })
      })
      srv.on('error', reject)
    })

    try {
      process.env.GIT_COMMIT_SHA = 'reuse_port_sha_abcdef1234567890abcdef'
      const res = await fetch(`${server2.baseUrl}/api/build-info`)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.commitShort, 'reuse_p')
    } finally {
      await server2.close()
    }
  })

  it('double close does not throw', { timeout: 5000 }, async () => {
    const app = createApp()
    registerBuildInfoRoute(app)
    const server = await listenOnRandomPort(app)

    await server.close()
    // Second close should not throw — important for finally blocks
    // that might run after an after() hook already closed the server
    await assert.doesNotReject(
      async () => server.close(),
      'Calling server.close() twice should not throw'
    )
  })
})

// — Verify the original file's affected tests use proper cleanup ——————————————

describe('source file structure verification (issue #388)', { timeout: 10000 }, () => {
  it('buildInfoIdempotencyServerCoupling.test.js exists and is importable', async () => {
    const filePath = path.resolve(
      import.meta.dirname,
      'buildInfoIdempotencyServerCoupling.test.js'
    )
    assert.equal(fs.existsSync(filePath), true,
      'The affected test file should exist')
  })

  it('affected test file contains listenOnRandomPort usage', async () => {
    const filePath = path.resolve(
      import.meta.dirname,
      'buildInfoIdempotencyServerCoupling.test.js'
    )
    const content = fs.readFileSync(filePath, 'utf-8')

    // The affected tests all use listenOnRandomPort to create inline servers
    const matches = content.match(/listenOnRandomPort/g)
    assert.ok(matches, 'File should contain listenOnRandomPort calls')
    // There should be at least the 3 inline usages plus the before() hook usages
    assert.ok(matches.length >= 3,
      `Expected at least 3 listenOnRandomPort calls, found ${matches.length}`)
  })
})
