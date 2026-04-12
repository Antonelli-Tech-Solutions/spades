/**
 * TDD tests for GitHub issue #350:
 *
 * The shadow test (buildInfoEnvIsolation.shadow.test.js) reads the target test
 * file as raw text via fs.readFile and validates naming conventions with regex.
 * This is fragile: refactors like extracting helpers, renaming the file, or
 * changing the snapshot pattern will silently break these tests without any
 * actual regression.
 *
 * The fix replaces the regex-based shadow test with an ESLint `no-shadow` rule
 * that enforces the same constraint more robustly and with less maintenance.
 *
 * These tests verify:
 * 1. ESLint is installed as a dev dependency
 * 2. An ESLint config exists with the `no-shadow` rule enabled
 * 3. The target test file passes ESLint's `no-shadow` rule (no shadowed vars)
 * 4. The fragile regex-based shadow test file has been removed
 * 5. The `no-shadow` rule actually catches real shadow violations (functional)
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access, writeFile, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const SHADOW_TEST_FILE = join(__dirname, 'buildInfoEnvIsolation.shadow.test.js')
const TARGET_TEST_FILE = join(__dirname, 'buildInfoEnvIsolation.test.js')
const ESLINT_BIN = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')

function eslint(args, opts = {}) {
  return execFileAsync(process.execPath, [ESLINT_BIN, ...args], { cwd: ROOT, timeout: 15000, ...opts })
}

describe('issue #350 — replace fragile regex shadow test with ESLint no-shadow rule', () => {
  // ---------------------------------------------------------------
  // Prerequisite: ESLint is available
  // ---------------------------------------------------------------

  it('eslint is listed as a devDependency in package.json', { timeout: 5000 }, async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'))
    const devDeps = pkg.devDependencies || {}
    assert.ok(
      devDeps.eslint,
      'Expected "eslint" to be listed in devDependencies. ' +
      'Install it with: npm install --save-dev eslint'
    )
  })

  // ---------------------------------------------------------------
  // ESLint config: no-shadow rule is enabled
  // ---------------------------------------------------------------

  it('ESLint config exists at the project root', { timeout: 5000 }, async () => {
    // Check for any of the common ESLint config file names
    const configNames = [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      '.eslintrc.json',
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.yml',
      '.eslintrc.yaml',
      '.eslintrc',
    ]

    let found = false
    let foundName = null
    for (const name of configNames) {
      try {
        await access(join(ROOT, name))
        found = true
        foundName = name
        break
      } catch {
        // try next
      }
    }

    // Also check package.json for eslintConfig key
    if (!found) {
      const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'))
      if (pkg.eslintConfig) {
        found = true
        foundName = 'package.json (eslintConfig key)'
      }
    }

    assert.ok(found,
      'No ESLint configuration file found at project root. ' +
      `Checked: ${configNames.join(', ')} and package.json eslintConfig key`)
  })

  it('ESLint config enables the no-shadow rule', { timeout: 10000 }, async () => {
    try {
      const { stdout } = await eslint(['--print-config', TARGET_TEST_FILE])
      const config = JSON.parse(stdout)
      const noShadow = config.rules && config.rules['no-shadow']

      assert.ok(noShadow,
        'Expected the "no-shadow" rule to be present in the resolved ESLint config')

      const severity = Array.isArray(noShadow) ? noShadow[0] : noShadow
      const isEnabled = severity === 'error' || severity === 'warn' || severity === 2 || severity === 1
      assert.ok(isEnabled,
        `Expected "no-shadow" rule to be enabled (error or warn), got: ${JSON.stringify(noShadow)}`)
    } catch (err) {
      assert.fail(
        `Failed to resolve ESLint config: ${err.message}. ` +
        'Ensure eslint is installed and configured with the no-shadow rule.')
    }
  })

  // ---------------------------------------------------------------
  // The target test file passes the no-shadow rule
  // ---------------------------------------------------------------

  it('buildInfoEnvIsolation.test.js passes ESLint no-shadow check', { timeout: 15000 }, async () => {
    try {
      await eslint([
        '--no-eslintrc', '--rule', '{"no-shadow": "error"}',
        '--parser-options', 'ecmaVersion:2022,sourceType:module',
        TARGET_TEST_FILE,
      ])
    } catch (err) {
      if (err.stdout) {
        assert.fail(
          `ESLint no-shadow violations found in buildInfoEnvIsolation.test.js:\n${err.stdout}`)
      }
      assert.fail(
        `ESLint execution failed: ${err.message}. Ensure eslint is installed.`)
    }
  })

  // ---------------------------------------------------------------
  // The fragile regex-based shadow test has been removed
  // ---------------------------------------------------------------

  it('the regex-based shadow test file has been removed', { timeout: 2000 }, async () => {
    let exists = true
    try {
      await access(SHADOW_TEST_FILE)
    } catch {
      exists = false
    }

    assert.equal(exists, false,
      'buildInfoEnvIsolation.shadow.test.js still exists. ' +
      'This fragile regex-based test should be removed in favor of the ESLint no-shadow rule.')
  })

  // ---------------------------------------------------------------
  // Functional: no-shadow rule catches real shadow violations
  // ---------------------------------------------------------------

  it('no-shadow rule detects when a local variable shadows an import', { timeout: 15000 }, async () => {
    const violatingCode = [
      'import { before } from "node:test";',
      'function test() {',
      '  const before = 42;',
      '  return before;',
      '}',
      'test();',
    ].join('\n')

    const tmpFile = join(ROOT, '_tmp_shadow_violation_check.js')
    try {
      await writeFile(tmpFile, violatingCode, 'utf-8')
      await eslint([
        '--no-eslintrc', '--rule', '{"no-shadow": "error"}',
        '--parser-options', 'ecmaVersion:2022,sourceType:module',
        tmpFile,
      ])
      assert.fail(
        'ESLint did not report a no-shadow violation for code that shadows an import. ' +
        'The rule may not be working correctly.')
    } catch (err) {
      if (err.code === 'ERR_ASSERTION') throw err
      if (err.stdout && err.stdout.includes('no-shadow')) {
        assert.ok(true)
      } else if (err.stdout && err.stdout.includes('shadow')) {
        assert.ok(true)
      } else if (err.code !== null && err.stderr && !err.stderr.includes('not found')) {
        assert.ok(true)
      } else {
        assert.fail(
          `Unexpected eslint behavior: ${err.message}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`)
      }
    } finally {
      try { await unlink(tmpFile) } catch { /* ignore */ }
    }
  })

  it('no-shadow rule passes clean code where no imports are shadowed', { timeout: 15000 }, async () => {
    const cleanCode = [
      'import { before } from "node:test";',
      'function test() {',
      '  const envBefore = 42;',
      '  return envBefore;',
      '}',
      'before(() => {});',
      'test();',
    ].join('\n')

    const tmpFile = join(ROOT, '_tmp_shadow_clean_check.js')
    try {
      await writeFile(tmpFile, cleanCode, 'utf-8')
      await eslint([
        '--no-eslintrc', '--rule', '{"no-shadow": "error"}',
        '--parser-options', 'ecmaVersion:2022,sourceType:module',
        tmpFile,
      ])
      assert.ok(true)
    } catch (err) {
      assert.fail(
        `ESLint reported violations on clean code (no shadowing): ${err.stdout || err.message}`)
    } finally {
      try { await unlink(tmpFile) } catch { /* ignore */ }
    }
  })

  // ---------------------------------------------------------------
  // Lint script: npm run lint is available
  // ---------------------------------------------------------------

  it('package.json has a "lint" script that runs eslint', { timeout: 5000 }, async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'))
    const scripts = pkg.scripts || {}

    assert.ok(scripts.lint,
      'Expected a "lint" script in package.json so developers can run `npm run lint`')
    assert.ok(scripts.lint.includes('eslint'),
      `Expected the lint script to invoke eslint, got: "${scripts.lint}"`)
  })
})
