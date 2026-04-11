/**
 * TDD tests for GitHub issue #328:
 *
 * On line 66 of buildInfoEnvIsolation.test.js, `const before = Object.hasOwn(...)`
 * shadows the `before` lifecycle hook imported from `node:test` on line 11.
 * While this doesn't cause a runtime bug in the current test (the lifecycle
 * `before` is only used at the describe level), it's confusing and could cause
 * issues if someone later tries to use the `before` hook inside that test scope.
 *
 * The fix is to rename the local variable to `envBefore`, which is already the
 * convention used in the later test (line 179 in the original file).
 *
 * These tests verify:
 * 1. No local variable named `before` shadows the imported lifecycle hook
 * 2. The `envBefore` naming convention is used consistently for env snapshots
 * 3. The `before` import is present and only used as a lifecycle hook call
 * 4. The save-and-restore pattern works correctly with `envBefore`
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TARGET_FILE = join(__dirname, 'buildInfoEnvIsolation.test.js')

async function getSource() {
  return readFile(TARGET_FILE, 'utf-8')
}

describe('issue #328 — no shadowing of `before` lifecycle hook', () => {
  // ---------------------------------------------------------------
  // Core check: no local variable declaration named `before`
  // ---------------------------------------------------------------

  it('does not declare a local variable named `before` anywhere in the file', { timeout: 2000 }, async () => {
    const source = await getSource()

    // Match const/let/var before = ... (local variable declarations)
    // This should NOT appear anywhere — the lifecycle hook `before` from
    // node:test should never be shadowed by a local variable.
    const localBeforeDecl = /\b(?:const|let|var)\s+before\s*=/g
    const matches = source.match(localBeforeDecl)

    assert.equal(matches, null,
      'Found local variable declaration(s) named `before` that shadow the lifecycle hook import. ' +
      'Rename to `envBefore` to avoid shadowing.')
  })

  // ---------------------------------------------------------------
  // Consistency: envBefore naming convention for env snapshots
  // ---------------------------------------------------------------

  it('uses `envBefore` (not `before`) for env-var snapshot variables', { timeout: 2000 }, async () => {
    const source = await getSource()

    // The try/finally restore pattern should use envBefore, not before
    const envBeforeDecl = /\bconst\s+envBefore\s*=/g
    const envBeforeMatches = source.match(envBeforeDecl)

    assert.ok(envBeforeMatches !== null && envBeforeMatches.length > 0,
      'Expected at least one `const envBefore = ...` declaration for env-var snapshots')
  })

  it('all env-var snapshot variables use the `envBefore` name consistently', { timeout: 2000 }, async () => {
    const source = await getSource()

    // Count env-var snapshot patterns: Object.hasOwn(process.env, ...) assigned to a variable
    const envSnapshotPattern = /\b(?:const|let|var)\s+(\w+)\s*=\s*Object\.hasOwn\(process\.env/g
    const allSnapshots = [...source.matchAll(envSnapshotPattern)]

    assert.ok(allSnapshots.length > 0,
      'Expected at least one env-var snapshot using Object.hasOwn(process.env, ...)')

    for (const match of allSnapshots) {
      const varName = match[1]
      assert.equal(varName, 'envBefore',
        `Env-var snapshot variable is named '${varName}' but should be 'envBefore' for consistency`)
    }
  })

  // ---------------------------------------------------------------
  // Import integrity: `before` is imported and used as lifecycle hook
  // ---------------------------------------------------------------

  it('imports `before` from node:test', { timeout: 2000 }, async () => {
    const source = await getSource()

    // Verify before is in the import statement from node:test
    const importLine = source.match(/import\s*\{([^}]+)\}\s*from\s*['"]node:test['"]/)
    assert.ok(importLine, 'Expected an import from node:test')

    const importedNames = importLine[1].split(',').map(s => s.trim())
    assert.ok(importedNames.includes('before'),
      'Expected `before` to be imported from node:test')
  })

  it('uses `before` only as a lifecycle hook call, not as a local variable', { timeout: 2000 }, async () => {
    const source = await getSource()
    const lines = source.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Skip the import line
      if (line.includes('from') && line.includes('node:test')) continue

      // If `before` appears on a line, it should be a lifecycle hook call:
      //   before(async () => { ... })
      // It should NOT be a variable name in: const before = ..., if (before !== ...), etc.
      // (Allow `envBefore` since that's the correct naming)
      const beforeAsVar = /\bbefore\b(?!\s*\()/
      const beforeMatch = line.match(beforeAsVar)
      if (beforeMatch) {
        // Allow comments mentioning `before`
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

        assert.fail(
          `Line ${i + 1}: found 'before' used as a variable (not a lifecycle hook call): ${line.trim()}`)
      }
    }
  })

  // ---------------------------------------------------------------
  // Restore pattern: envBefore is used correctly in try/finally
  // ---------------------------------------------------------------

  it('references `envBefore` (not `before`) in restore blocks', { timeout: 2000 }, async () => {
    const source = await getSource()

    // In finally/restore blocks, the variable used should be envBefore
    // Check that there's no `if (before !== undefined)` pattern (that would
    // indicate the shadowing variable is still being used for restore logic)
    const restoreWithBefore = /if\s*\(\s*before\s*!==\s*undefined\s*\)/g
    const badRestores = source.match(restoreWithBefore)

    assert.equal(badRestores, null,
      'Found restore pattern using `before` instead of `envBefore`. ' +
      'The try/finally restore should reference `envBefore`.')
  })

  it('has matching save and restore for envBefore in try/finally blocks', { timeout: 2000 }, async () => {
    const source = await getSource()

    // Every `const envBefore = ` should have a corresponding restore in a finally block
    const saves = (source.match(/const\s+envBefore\s*=/g) || []).length
    const restores = (source.match(/if\s*\(\s*envBefore\s*!==\s*undefined\s*\)/g) || []).length

    assert.ok(saves > 0, 'Expected at least one envBefore save')
    assert.ok(restores > 0, 'Expected at least one envBefore restore check')
    // Each save should have at least one restore (could have 2 — one in finally, one after)
    assert.ok(restores >= saves,
      `Found ${saves} envBefore save(s) but only ${restores} restore check(s)`)
  })
})
