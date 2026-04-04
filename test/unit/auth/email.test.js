import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildVerificationEmailContent, buildPasswordResetEmailContent } from '../../../server/auth/email.js'

describe('buildVerificationEmailContent', { timeout: 2000 }, () => {
  it('includes the full verification URL in the plain-text body', { timeout: 2000 }, () => {
    const token = 'abc-123-token'
    const appUrl = 'https://spades.example.com'
    const { text } = buildVerificationEmailContent(token, appUrl)
    assert.ok(
      text.includes(`${appUrl}/api/auth/verify-email?token=${token}`),
      'plain text should contain the verification URL',
    )
  })

  it('includes the full verification URL in the HTML body', { timeout: 2000 }, () => {
    const token = 'abc-123-token'
    const appUrl = 'https://spades.example.com'
    const { html } = buildVerificationEmailContent(token, appUrl)
    assert.ok(
      html.includes(`${appUrl}/api/auth/verify-email?token=${token}`),
      'HTML body should contain the verification URL',
    )
  })

  it('has a non-empty subject line', { timeout: 2000 }, () => {
    const { subject } = buildVerificationEmailContent('tok', 'https://example.com')
    assert.ok(typeof subject === 'string' && subject.length > 0)
  })

  it('mentions the 24-hour expiry window', { timeout: 2000 }, () => {
    const { text } = buildVerificationEmailContent('tok', 'https://example.com')
    assert.ok(text.includes('24 hours'), 'should tell the user the link expires in 24 hours')
  })
})

describe('buildPasswordResetEmailContent', { timeout: 2000 }, () => {
  it('includes the full reset URL in the plain-text body', { timeout: 2000 }, () => {
    const token = 'reset-token-123'
    const appUrl = 'https://spades.example.com'
    const { text } = buildPasswordResetEmailContent(token, appUrl)
    assert.ok(
      text.includes(`${appUrl}/#/reset-password?token=${token}`),
      'plain text should contain the reset URL',
    )
  })

  it('includes the full reset URL in the HTML body', { timeout: 2000 }, () => {
    const token = 'reset-token-123'
    const appUrl = 'https://spades.example.com'
    const { html } = buildPasswordResetEmailContent(token, appUrl)
    assert.ok(
      html.includes(`${appUrl}/#/reset-password?token=${token}`),
      'HTML body should contain the reset URL',
    )
  })

  it('has a non-empty subject line', { timeout: 2000 }, () => {
    const { subject } = buildPasswordResetEmailContent('tok', 'https://example.com')
    assert.ok(typeof subject === 'string' && subject.length > 0)
  })

  it('mentions the 1-hour expiry window', { timeout: 2000 }, () => {
    const { text } = buildPasswordResetEmailContent('tok', 'https://example.com')
    assert.ok(text.includes('1 hour'), 'should tell the user the link expires in 1 hour')
  })
})
