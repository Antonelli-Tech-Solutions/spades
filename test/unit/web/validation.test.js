import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateRegisterForm,
  validateLoginForm,
} from '../../../client/web/src/validation.js'

describe('validateRegisterForm', () => {
  it('returns null for valid inputs', () => {
    assert.equal(
      validateRegisterForm({ email: 'alice@example.com', username: 'alice', password: 'password123' }),
      null,
    )
  })

  it('returns an error when email is missing', () => {
    assert.ok(validateRegisterForm({ email: '', username: 'alice', password: 'password123' }))
  })

  it('returns an error when email has no @', () => {
    assert.ok(validateRegisterForm({ email: 'notanemail', username: 'alice', password: 'password123' }))
  })

  it('returns an error when username is missing', () => {
    assert.ok(validateRegisterForm({ email: 'alice@example.com', username: '', password: 'password123' }))
  })

  it('returns an error when username is too short (1 char)', () => {
    assert.ok(validateRegisterForm({ email: 'alice@example.com', username: 'a', password: 'password123' }))
  })

  it('returns null when username is exactly 2 chars', () => {
    assert.equal(
      validateRegisterForm({ email: 'alice@example.com', username: 'al', password: 'password123' }),
      null,
    )
  })

  it('returns an error when password is missing', () => {
    assert.ok(validateRegisterForm({ email: 'alice@example.com', username: 'alice', password: '' }))
  })

  it('returns an error when password is fewer than 8 characters', () => {
    assert.ok(validateRegisterForm({ email: 'alice@example.com', username: 'alice', password: 'short' }))
  })

  it('returns null when password is exactly 8 characters', () => {
    assert.equal(
      validateRegisterForm({ email: 'alice@example.com', username: 'alice', password: '12345678' }),
      null,
    )
  })
})

describe('validateLoginForm', () => {
  it('returns null for valid inputs', () => {
    assert.equal(validateLoginForm({ email: 'alice@example.com', password: 'password123' }), null)
  })

  it('returns an error when email is missing', () => {
    assert.ok(validateLoginForm({ email: '', password: 'password123' }))
  })

  it('returns an error when email has no @', () => {
    assert.ok(validateLoginForm({ email: 'notanemail', password: 'password123' }))
  })

  it('returns an error when password is missing', () => {
    assert.ok(validateLoginForm({ email: 'alice@example.com', password: '' }))
  })
})
