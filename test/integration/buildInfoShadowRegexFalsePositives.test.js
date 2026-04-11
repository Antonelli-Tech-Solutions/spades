/**
 * TDD tests for GitHub issue #351:
 *
 * The old shadow test (buildInfoEnvIsolation.shadow.test.js, line 107) used
 * `/\bbefore\b(?!\s*\()/` to flag any non-call usage of `before`, but its
 * skip logic only handled lines starting with `//`, `*`, or `/*`. This caused
 * false positives for:
 *   - Trailing comments: `doSomething() // uses before hook`
 *   - String literals: `const msg = "run before tests"`
 *   - JSDoc @param tags: `@param {Function} before`
 *   - Template literals: `\`value before change: ${x}\``
 *
 * The fix (issue #350) replaced the regex-based approach with ESLint's
 * `no-shadow` rule. These tests verify:
 * 1. The old fragile regex approach is gone (shadow test file removed)
 * 2. ESLint no-shadow does NOT false-positive on trailing comments containing 'before'
 * 3. ESLint no-shadow does NOT false-positive on string literals containing 'before'
 * 4. ESLint no-shadow does NOT false-positive on JSDoc @param tags with 'before'
 * 5. ESLint no-shadow does NOT false-positive on template literals containing 'before'
 * 6. ESLint no-shadow still catches real shadow violations (true positives preserved)
 * 7. The old regex pattern itself would have produced false positives on these inputs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const { ESLint } = require('eslint')
const __dirname = dirname(fileURLToPath(import.meta.url))
const SHADOW_TEST_FILE = join(__dirname, 'buildInfoEnvIsolation.shadow.test.js')

/**
 * The old fragile regex and skip logic from the deleted shadow test (line 107).
 * Reproduced here to prove these patterns would have caused false positives.
 */
const OLD_REGEX = /\bbefore\b(?!\s*\()/
function oldSkipLogicWouldSkip(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}
function oldRegexWouldFlag(line) {
  if (line.includes('from') && line.includes('node:test')) return false
  if (oldSkipLogicWouldSkip(line)) return false
  return OLD_REGEX.test(line)
}

/**
 * Helper: run ESLint no-shadow on a code snippet using the Node API.
 * Returns { passed: true } if clean, or { passed: false, messages } if violations found.
 */
async function runEslintNoShadow(code) {
  const eslint = new ESLint({
    useEslintrc: false,
    overrideConfig: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      rules: { 'no-shadow': 'error' },
    },
  })
  const results = await eslint.lintText(code, { filePath: 'test-issue-351.js' })
  const messages = results[0].messages.filter(m => m.ruleId === 'no-shadow')
  return { passed: messages.length === 0, messages }
}

describe('issue #351 — fragile regex skip logic causes false positives', () => {
  // ---------------------------------------------------------------
  // Prerequisite: the old shadow test file is gone
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
      'The fragile regex-based test should be removed (issue #350).')
  })

  // ---------------------------------------------------------------
  // Old regex false positives: prove the old approach was broken
  // ---------------------------------------------------------------

  describe('old regex would produce false positives on innocuous code', () => {
    it('false positive: trailing comment containing "before"', { timeout: 2000 }, () => {
      const line = '    doSomething() // uses before hook'
      assert.equal(oldRegexWouldFlag(line), true,
        'Expected old regex to falsely flag a trailing comment containing "before"')
    })

    it('false positive: string literal containing "before"', { timeout: 2000 }, () => {
      const line = '    const msg = "run before tests"'
      assert.equal(oldRegexWouldFlag(line), true,
        'Expected old regex to falsely flag a string literal containing "before"')
    })

    it('false positive: template literal containing "before"', { timeout: 2000 }, () => {
      const line = '    const msg = `value before change: ${x}`'
      assert.equal(oldRegexWouldFlag(line), true,
        'Expected old regex to falsely flag a template literal containing "before"')
    })

    it('false positive: JSDoc @param tag not starting with * or /*', { timeout: 2000 }, () => {
      const paramLine = '  @param {Function} before - the lifecycle hook'
      assert.equal(oldRegexWouldFlag(paramLine), true,
        'Expected old regex to falsely flag a JSDoc @param line not starting with * or /*')
    })

    it('false positive: single-quoted string literal containing "before"', { timeout: 2000 }, () => {
      const line = "    const label = 'before hook cleanup'"
      assert.equal(oldRegexWouldFlag(line), true,
        'Expected old regex to falsely flag a single-quoted string containing "before"')
    })

    it('false positive: object property containing "before"', { timeout: 2000 }, () => {
      const line = '    const result = { before: savedValue }'
      assert.equal(oldRegexWouldFlag(line), true,
        'Expected old regex to falsely flag an object property named "before"')
    })

    it('false positive: property access expression with "before"', { timeout: 2000 }, () => {
      const line = '    if (snapshot.before !== undefined) {'
      assert.equal(oldRegexWouldFlag(line), true,
        'Expected old regex to falsely flag "snapshot.before" property access')
    })
  })

  // ---------------------------------------------------------------
  // Old regex true positives: it correctly caught real shadows
  // ---------------------------------------------------------------

  describe('old regex correctly flagged actual shadow declarations', () => {
    it('catches const before = ... declaration', { timeout: 2000 }, () => {
      const line = '    const before = Object.hasOwn(process.env, "GIT_COMMIT_SHA")'
      assert.equal(oldRegexWouldFlag(line), true,
        'Old regex should flag a local variable declaration shadowing the import')
    })

    it('does not flag before() lifecycle hook call', { timeout: 2000 }, () => {
      const line = '  before(async () => {'
      assert.equal(oldRegexWouldFlag(line), false,
        'Old regex should not flag before() when used as a function call')
    })
  })

  // ---------------------------------------------------------------
  // ESLint no-shadow: no false positives on the same inputs
  // ---------------------------------------------------------------

  describe('ESLint no-shadow does NOT false-positive on innocuous "before" usage', () => {
    it('passes code with trailing comment containing "before"', { timeout: 10000 }, async () => {
      const code = [
        'import { before } from "node:test";',
        'before(() => {});',
        'function setup() {',
        '  const x = 1; // uses before hook',
        '  return x;',
        '}',
        'setup();',
      ].join('\n')

      const result = await runEslintNoShadow(code)
      assert.ok(result.passed,
        `ESLint should not flag trailing comment containing "before". Got: ${JSON.stringify(result.messages)}`)
    })

    it('passes code with string literal containing "before"', { timeout: 10000 }, async () => {
      const code = [
        'import { before } from "node:test";',
        'before(() => {});',
        'function setup() {',
        '  const msg = "run before tests";',
        '  return msg;',
        '}',
        'setup();',
      ].join('\n')

      const result = await runEslintNoShadow(code)
      assert.ok(result.passed,
        `ESLint should not flag string literal containing "before". Got: ${JSON.stringify(result.messages)}`)
    })

    it('passes code with template literal containing "before"', { timeout: 10000 }, async () => {
      const code = [
        'import { before } from "node:test";',
        'before(() => {});',
        'function setup() {',
        '  const x = 42;',
        '  const msg = `value before change: ${x}`;',
        '  return msg;',
        '}',
        'setup();',
      ].join('\n')

      const result = await runEslintNoShadow(code)
      assert.ok(result.passed,
        `ESLint should not flag template literal containing "before". Got: ${JSON.stringify(result.messages)}`)
    })

    it('passes code with JSDoc @param containing "before"', { timeout: 10000 }, async () => {
      const code = [
        'import { before } from "node:test";',
        'before(() => {});',
        '/**',
        ' * @param {string} beforeLabel - label for the before state',
        ' */',
        'function setup(beforeLabel) {',
        '  return beforeLabel;',
        '}',
        'setup("test");',
      ].join('\n')

      const result = await runEslintNoShadow(code)
      assert.ok(result.passed,
        `ESLint should not flag JSDoc @param containing "before". Got: ${JSON.stringify(result.messages)}`)
    })

    it('passes code with object property named "before"', { timeout: 10000 }, async () => {
      const code = [
        'import { before } from "node:test";',
        'before(() => {});',
        'function setup() {',
        '  const result = { before: "saved" };',
        '  return result;',
        '}',
        'setup();',
      ].join('\n')

      const result = await runEslintNoShadow(code)
      assert.ok(result.passed,
        `ESLint should not flag object property key "before" with explicit value. Got: ${JSON.stringify(result.messages)}`)
    })

    it('passes code with "before" in a regex literal', { timeout: 10000 }, async () => {
      const code = [
        'import { before } from "node:test";',
        'before(() => {});',
        'function test() {',
        '  const re = /before/;',
        '  return re.test("before hook");',
        '}',
        'test();',
      ].join('\n')

      const result = await runEslintNoShadow(code)
      assert.ok(result.passed,
        `ESLint should not flag "before" inside a regex literal. Got: ${JSON.stringify(result.messages)}`)
    })

    it('passes code with "before" in a multi-line template literal', { timeout: 10000 }, async () => {
      const code = [
        'import { before } from "node:test";',
        'before(() => {});',
        'function test() {',
        '  const msg = `',
        '    value before change',
        '    is captured here',
        '  `;',
        '  return msg;',
        '}',
        'test();',
      ].join('\n')

      const result = await runEslintNoShadow(code)
      assert.ok(result.passed,
        `ESLint should not flag "before" inside a multi-line template literal. Got: ${JSON.stringify(result.messages)}`)
    })
  })

  // ---------------------------------------------------------------
  // ESLint no-shadow: true positives preserved (catches real shadows)
  // ---------------------------------------------------------------

  describe('ESLint no-shadow correctly catches real shadow violations', () => {
    it('flags const before = ... that shadows the import', { timeout: 10000 }, async () => {
      const code = [
        'import { before } from "node:test";',
        'before(() => {});',
        'function setup() {',
        '  const before = 42;',
        '  return before;',
        '}',
        'setup();',
      ].join('\n')

      const result = await runEslintNoShadow(code)
      assert.equal(result.passed, false,
        'ESLint should flag `const before = 42` as a shadow violation')
      assert.ok(result.messages.length > 0,
        'Expected at least one no-shadow message')
    })

    it('flags let before = ... that shadows the import', { timeout: 10000 }, async () => {
      const code = [
        'import { before } from "node:test";',
        'before(() => {});',
        'function setup() {',
        '  let before = null;',
        '  before = 42;',
        '  return before;',
        '}',
        'setup();',
      ].join('\n')

      const result = await runEslintNoShadow(code)
      assert.equal(result.passed, false,
        'ESLint should flag `let before = null` as a shadow violation')
    })

    it('flags function parameter named "before" that shadows the import', { timeout: 10000 }, async () => {
      const code = [
        'import { before } from "node:test";',
        'before(() => {});',
        'function setup(before) {',
        '  return before;',
        '}',
        'setup(42);',
      ].join('\n')

      const result = await runEslintNoShadow(code)
      assert.equal(result.passed, false,
        'ESLint should flag function parameter "before" as a shadow violation')
    })

    it('flags arrow function parameter named "before" that shadows the import', { timeout: 10000 }, async () => {
      const code = [
        'import { before } from "node:test";',
        'before(() => {});',
        'const setup = (before) => before;',
        'setup(42);',
      ].join('\n')

      const result = await runEslintNoShadow(code)
      assert.equal(result.passed, false,
        'ESLint should flag arrow function parameter "before" as a shadow violation')
    })
  })

  // ---------------------------------------------------------------
  // Edge cases: mixed patterns that old regex couldn't handle
  // ---------------------------------------------------------------

  describe('edge cases the old regex skip logic could not handle', () => {
    it('passes code where "before" appears in both a comment and a legitimate call', { timeout: 10000 }, async () => {
      const code = [
        'import { before } from "node:test";',
        '// Set up state before tests run',
        'before(() => { /* initialize before anything else */ });',
        'function test() {',
        '  return "done"; // before was called above',
        '}',
        'test();',
      ].join('\n')

      const result = await runEslintNoShadow(code)
      assert.ok(result.passed,
        `ESLint should handle mixed comment + call patterns cleanly. Got: ${JSON.stringify(result.messages)}`)
    })

    it('old regex would flag trailing comment but old skip logic would miss it', { timeout: 2000 }, () => {
      const line = '    doSomething() // the before hook ran'
      const trimmed = line.trim()

      // Verify the skip logic would NOT skip this line
      assert.equal(trimmed.startsWith('//'), false, 'Line does not start with //')
      assert.equal(trimmed.startsWith('*'), false, 'Line does not start with *')
      assert.equal(trimmed.startsWith('/*'), false, 'Line does not start with /*')

      // But the regex DOES match 'before' in the comment
      assert.equal(OLD_REGEX.test(line), true,
        'Old regex matches "before" in trailing comment')

      // Combined: the old test would flag this line as a violation
      assert.equal(oldRegexWouldFlag(line), true,
        'Old test would produce a false positive on this line')
    })

    it('old skip logic correctly skips full-line comments but misses inline ones', { timeout: 2000 }, () => {
      // Full-line comment: correctly skipped
      const fullLineComment = '  // before is used here'
      assert.equal(oldRegexWouldFlag(fullLineComment), false,
        'Full-line comment starting with // should be skipped by old logic')

      // Inline comment on code line: NOT skipped (the bug)
      const inlineComment = '  setup() // before is used here'
      assert.equal(oldRegexWouldFlag(inlineComment), true,
        'Inline comment should NOT be skipped by old logic (this is the bug)')
    })
  })
})
