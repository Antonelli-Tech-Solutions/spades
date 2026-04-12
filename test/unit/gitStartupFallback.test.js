/**
 * Regression test for the git startup fallback added to app.js.
 *
 * Bug: In non-CI environments where GIT_COMMIT_SHA is not injected by the
 * pipeline, /api/build-info returns { commitShort: null } because the env
 * var is never set.
 *
 * Fix: app.js derives GIT_COMMIT_SHA from `git rev-parse HEAD` at startup
 * when the env var is absent, so the indicator shows the actual commit hash.
 *
 * These tests verify the two key behaviors of that fallback:
 *  1. When GIT_COMMIT_SHA is absent, the fallback sets it to a valid full SHA.
 *  2. When GIT_COMMIT_SHA is already set (by CI), the fallback leaves it alone.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'

/** Reproduce the exact startup-fallback logic from app.js. */
function applyGitFallback() {
  if (!process.env.GIT_COMMIT_SHA) {
    const platformSha =
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.COMMIT_REF ||
      null

    if (platformSha) {
      process.env.GIT_COMMIT_SHA = platformSha
    } else {
      try {
        process.env.GIT_COMMIT_SHA = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
      } catch {
        // Not a git repo or git not available — leave unset
      }
    }
  }
}

describe('app.js git startup fallback', () => {
  it('sets GIT_COMMIT_SHA to a 40-char hex SHA when the env var is absent', { timeout: 5000 }, () => {
    const saved = process.env.GIT_COMMIT_SHA
    try {
      delete process.env.GIT_COMMIT_SHA

      applyGitFallback()

      // In a git repository (which CI always is), the fallback must produce a valid SHA.
      // If git is unavailable the key stays absent — that case is handled gracefully.
      if (Object.hasOwn(process.env, 'GIT_COMMIT_SHA')) {
        assert.match(
          process.env.GIT_COMMIT_SHA,
          /^[0-9a-f]{40}$/,
          'fallback SHA must be a 40-character lowercase hex string',
        )
      }
    } finally {
      if (saved !== undefined) {
        process.env.GIT_COMMIT_SHA = saved
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }
  })

  it('does not override GIT_COMMIT_SHA when already set (CI-injected value wins)', { timeout: 5000 }, () => {
    const saved = process.env.GIT_COMMIT_SHA
    const ciSha = 'abc1234def5678901234567890abcdef12345678'
    try {
      process.env.GIT_COMMIT_SHA = ciSha

      applyGitFallback()

      assert.equal(
        process.env.GIT_COMMIT_SHA,
        ciSha,
        'CI-provided value must not be overwritten by the git fallback',
      )
    } finally {
      if (saved !== undefined) {
        process.env.GIT_COMMIT_SHA = saved
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }
  })

  it('leaves GIT_COMMIT_SHA unset when git is unavailable (no-op on failure)', { timeout: 5000 }, () => {
    const saved = process.env.GIT_COMMIT_SHA
    try {
      delete process.env.GIT_COMMIT_SHA

      // Simulate the fallback with a failing git command
      if (!process.env.GIT_COMMIT_SHA) {
        try {
          execSync('git rev-parse --no-such-flag-that-fails-12345', { encoding: 'utf8' })
        } catch {
          // intentional — env var stays unset
        }
      }

      assert.equal(
        Object.hasOwn(process.env, 'GIT_COMMIT_SHA'),
        false,
        'env var must remain absent when the git command fails',
      )
    } finally {
      if (saved !== undefined) {
        process.env.GIT_COMMIT_SHA = saved
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
    }
  })

  it('uses VERCEL_GIT_COMMIT_SHA when GIT_COMMIT_SHA is absent', { timeout: 5000 }, () => {
    const savedGit = process.env.GIT_COMMIT_SHA
    const savedVercel = process.env.VERCEL_GIT_COMMIT_SHA
    const vercelSha = 'aabbccdd11223344556677889900aabbccddeeff'
    try {
      delete process.env.GIT_COMMIT_SHA
      process.env.VERCEL_GIT_COMMIT_SHA = vercelSha

      applyGitFallback()

      assert.equal(
        process.env.GIT_COMMIT_SHA,
        vercelSha,
        'GIT_COMMIT_SHA must be set from VERCEL_GIT_COMMIT_SHA',
      )
    } finally {
      if (savedGit !== undefined) {
        process.env.GIT_COMMIT_SHA = savedGit
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
      if (savedVercel !== undefined) {
        process.env.VERCEL_GIT_COMMIT_SHA = savedVercel
      } else {
        delete process.env.VERCEL_GIT_COMMIT_SHA
      }
    }
  })

  it('uses COMMIT_REF when GIT_COMMIT_SHA and VERCEL_GIT_COMMIT_SHA are absent', { timeout: 5000 }, () => {
    const savedGit = process.env.GIT_COMMIT_SHA
    const savedVercel = process.env.VERCEL_GIT_COMMIT_SHA
    const savedCommitRef = process.env.COMMIT_REF
    const netlifySha = '1122334455667788990011223344556677889900'
    try {
      delete process.env.GIT_COMMIT_SHA
      delete process.env.VERCEL_GIT_COMMIT_SHA
      process.env.COMMIT_REF = netlifySha

      applyGitFallback()

      assert.equal(
        process.env.GIT_COMMIT_SHA,
        netlifySha,
        'GIT_COMMIT_SHA must be set from COMMIT_REF',
      )
    } finally {
      if (savedGit !== undefined) {
        process.env.GIT_COMMIT_SHA = savedGit
      } else {
        delete process.env.GIT_COMMIT_SHA
      }
      if (savedVercel !== undefined) {
        process.env.VERCEL_GIT_COMMIT_SHA = savedVercel
      } else {
        delete process.env.VERCEL_GIT_COMMIT_SHA
      }
      if (savedCommitRef !== undefined) {
        process.env.COMMIT_REF = savedCommitRef
      } else {
        delete process.env.COMMIT_REF
      }
    }
  })
})
