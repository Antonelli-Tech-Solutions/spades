import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CROWN_ICON } from '../../../client/web/src/icons.js'

describe('CROWN_ICON', { timeout: 2000 }, () => {
  it('is a non-empty string', { timeout: 2000 }, () => {
    assert.equal(typeof CROWN_ICON, 'string')
    assert.ok(CROWN_ICON.length > 0)
  })

  it('is a valid SVG element', { timeout: 2000 }, () => {
    assert.ok(CROWN_ICON.startsWith('<svg'), 'should start with <svg')
    assert.ok(CROWN_ICON.endsWith('</svg>'), 'should end with </svg>')
  })

  it('uses the expected amber/gold fill color', { timeout: 2000 }, () => {
    assert.ok(CROWN_ICON.includes('#ffd54f'), 'should contain #ffd54f amber fill')
  })
})
