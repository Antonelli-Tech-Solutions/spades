/**
 * Tests for GitHub issue #352:
 *
 * The old shadow test (buildInfoEnvIsolation.shadow.test.js, line 144) used a
 * count-based assertion (`restores >= saves`) to verify env-var cleanup. This
 * gives a false sense of correctness: two `const envBefore` declarations in
 * nested scopes sharing one finally block (or vice versa) would satisfy the
 * count check while being structurally incorrect.
 *
 * The shadow test file was removed in issue #350. These tests verify:
 * 1. The shadow test file with the count-based assertion is still gone
 * 2. The env isolation test uses structural (value-based) assertions, not counts
 * 3. No count-based save/restore patterns exist in any buildInfo env test file
 * 4. Every save/restore pair in buildInfoEnvIsolation.test.js is verified by
 *    an actual env-var value check, not a counter
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SHADOW_TEST_FILE = join(__dirname, 'buildInfoEnvIsolation.shadow.test.js')
const ENV_ISOLATION_FILE = join(__dirname, 'buildInfoEnvIsolation.test.js')

describe('issue #352 — count-based save/restore assertions replaced by structural checks', () => {
  // ---------------------------------------------------------------
  // 1. Shadow test file with count-based assertion is gone
  // ---------------------------------------------------------------

  it('the shadow test file with the count-based assertion does not exist', { timeout: 2000 }, async () => {
    let exists = true
    try {
      await access(SHADOW_TEST_FILE)
    } catch {
      exists = false
    }
    assert.equal(exists, false,
      'buildInfoEnvIsolation.shadow.test.js should not exist — ' +
      'it contained a flawed count-based assertion (restores >= saves)')
  })

  // ---------------------------------------------------------------
  // 2. No count-based save/restore patterns in env isolation tests
  // ---------------------------------------------------------------

  it('buildInfoEnvIsolation.test.js contains no count-based save/restore assertions', { timeout: 2000 }, async () => {
    const source = await readFile(ENV_ISOLATION_FILE, 'utf8')

    const countPatterns = [
      /restores?\s*>=\s*saves?/,
      /saves?\s*<=\s*restores?/,
      /saveCount/,
      /restoreCount/,
      /\.length\s*>=.*save/,
      /\.length\s*>=.*restore/,
    ]

    for (const pattern of countPatterns) {
      assert.equal(pattern.test(source), false,
        `Found count-based assertion pattern ${pattern} in buildInfoEnvIsolation.test.js. ` +
        'Use structural value-based assertions instead (issue #352).')
    }
  })

  // ---------------------------------------------------------------
  // 3. Env isolation test uses structural assertions (value checks)
  // ---------------------------------------------------------------

  it('buildInfoEnvIsolation.test.js uses value-based env assertions', { timeout: 2000 }, async () => {
    const source = await readFile(ENV_ISOLATION_FILE, 'utf8')

    assert.ok(
      source.includes('assert.equal(process.env.GIT_COMMIT_SHA'),
      'Expected structural assertion checking actual env var value'
    )

    assert.ok(
      source.includes('Object.hasOwn(process.env,'),
      'Expected Object.hasOwn check for env var existence'
    )
  })

  it('every try/finally block in buildInfoEnvIsolation.test.js has a matching restoreEnv call', { timeout: 2000 }, async () => {
    const source = await readFile(ENV_ISOLATION_FILE, 'utf8')
    const lines = source.split('\n')

    const tryLines = []
    const finallyRestoreLines = []

    for (let i = 0; i < lines.length; i++) {
      if (/\btry\s*\{/.test(lines[i])) {
        tryLines.push(i + 1)
      }
      if (/\bfinally\s*\{/.test(lines[i])) {
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          if (/restoreEnv\(/.test(lines[j])) {
            finallyRestoreLines.push(i + 1)
            break
          }
        }
      }
    }

    assert.ok(tryLines.length > 0,
      'Expected at least one try block in env isolation tests')
    assert.ok(finallyRestoreLines.length > 0,
      'Expected at least one finally block with restoreEnv call')
  })

  // ---------------------------------------------------------------
  // 4. No count-based patterns in any buildInfo env test file
  // ---------------------------------------------------------------

  it('no buildInfo test file uses count-based save/restore assertions', { timeout: 2000 }, async () => {
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(__dirname)
    const ownFile = 'buildInfoEnvIsolationStructuralAssertions.test.js'
    const buildInfoEnvFiles = files.filter(f =>
      f.startsWith('buildInfo') && f.includes('Env') && f.endsWith('.test.js') && f !== ownFile
    )

    assert.ok(buildInfoEnvFiles.length > 0,
      'Expected at least one buildInfo env test file')

    for (const file of buildInfoEnvFiles) {
      const source = await readFile(join(__dirname, file), 'utf8')
      const hasCountPattern =
        /restores?\s*>=\s*saves?/.test(source) ||
        /saves?\s*<=\s*restores?/.test(source) ||
        /saveCount/.test(source) ||
        /restoreCount/.test(source)

      assert.equal(hasCountPattern, false,
        `${file} contains a count-based save/restore assertion. ` +
        'Use structural value-based assertions instead (issue #352).')
    }
  })
})
