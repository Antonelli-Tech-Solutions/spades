import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildVerificationEmailContent } from '../../../server/auth/email.js'

describe('buildVerificationEmailContent', () => {
  it('includes the full verification URL in the plain-text body', () => {
    const token = 'abc-123-token'
    const appUrl = 'https://spades.example.com'
    const { text } = buildVerificationEmailContent(token, appUrl)
    assert.ok(
      text.includes(`${appUrl}/api/auth/verify-email?token=${token}`),
      'plain text should contain the verification URL',
    )
  })

  it('includes the full verification URL in the HTML body', () => {
    const token = 'abc-123-token'
    const appUrl = 'https://spades.example.com'
    const { html } = buildVerificationEmailContent(token, appUrl)
    assert.ok(
      html.includes(`${appUrl}/api/auth/verify-email?token=${token}`),
      'HTML body should contain the verification URL',
    )
  })

  it('has a non-empty subject line', () => {
    const { subject } = buildVerificationEmailContent('tok', 'https://example.com')
    assert.ok(typeof subject === 'string' && subject.length > 0)
  })

  it('mentions the 24-hour expiry window', () => {
    const { text } = buildVerificationEmailContent('tok', 'https://example.com')
    assert.ok(text.includes('24 hours'), 'should tell the user the link expires in 24 hours')
  })
})
