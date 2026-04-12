/**
 * TDD tests for issue #520: missing build-info commit indicator in the UI.
 *
 * Covers two pieces that must be implemented:
 *   1. getBuildInfo() API client function in client/web/src/api.js
 *   2. Build indicator UI module in client/web/src/buildIndicator.js
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/* ------------------------------------------------------------------ */
/*  1. API client — getBuildInfo()                                     */
/* ------------------------------------------------------------------ */

import { getBuildInfo } from '../../../client/web/src/api.js'

function mockFetch(status, body) {
  return async (_url, _opts) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

function capturingFetch(status, body) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }
  fn.calls = calls
  return fn
}

describe('getBuildInfo', { timeout: 2000 }, () => {
  it('resolves with commitShort on 200', { timeout: 2000 }, async () => {
    const result = await getBuildInfo(
      mockFetch(200, { commitShort: 'abc1234' }),
    )
    assert.equal(result.commitShort, 'abc1234')
  })

  it('resolves with null commitShort when server returns null', { timeout: 2000 }, async () => {
    const result = await getBuildInfo(
      mockFetch(200, { commitShort: null }),
    )
    assert.equal(result.commitShort, null)
  })

  it('calls GET /api/build-info with no auth headers', { timeout: 2000 }, async () => {
    const spy = capturingFetch(200, { commitShort: 'abc1234' })
    await getBuildInfo(spy)

    assert.equal(spy.calls.length, 1)
    assert.equal(spy.calls[0].url, '/api/build-info')

    const opts = spy.calls[0].opts || {}
    assert.ok(!opts.method || opts.method === 'GET', 'should use GET')
    const headers = opts.headers || {}
    assert.equal(headers['x-session-id'], undefined, 'should not send session header')
    assert.equal(headers['x-player-id'], undefined, 'should not send player header')
  })

  it('throws on server error (500)', { timeout: 2000 }, async () => {
    await assert.rejects(
      () => getBuildInfo(mockFetch(500, { error: 'Internal server error' })),
      (err) => {
        assert.equal(err.status, 500)
        return true
      },
    )
  })

  it('throws a generic message when response body has no error field', { timeout: 2000 }, async () => {
    await assert.rejects(
      () => getBuildInfo(mockFetch(500, {})),
      (err) => {
        assert.ok(err.message)
        return true
      },
    )
  })
})

/* ------------------------------------------------------------------ */
/*  2. Build indicator UI module                                       */
/* ------------------------------------------------------------------ */

import { renderBuildIndicator, createBuildIndicatorElement } from '../../../client/web/src/buildIndicator.js'

describe('createBuildIndicatorElement', { timeout: 2000 }, () => {
  it('returns an HTML string containing the commit hash', { timeout: 2000 }, () => {
    const html = createBuildIndicatorElement('abc1234')
    assert.equal(typeof html, 'string')
    assert.ok(html.includes('abc1234'), 'should contain the commit hash')
  })

  it('includes an element with id "build-indicator"', { timeout: 2000 }, () => {
    const html = createBuildIndicatorElement('abc1234')
    assert.ok(html.includes('build-indicator'), 'should have build-indicator id')
  })

  it('positions the indicator in the bottom-right via inline style or class', { timeout: 2000 }, () => {
    const html = createBuildIndicatorElement('abc1234')
    const hasBottomRight =
      (html.includes('bottom') && html.includes('right')) ||
      html.includes('build-indicator')
    assert.ok(hasBottomRight, 'should indicate bottom-right positioning')
  })

  it('returns empty string when commitShort is null', { timeout: 2000 }, () => {
    const html = createBuildIndicatorElement(null)
    assert.equal(html, '', 'should return empty string for null commit')
  })

  it('returns empty string when commitShort is undefined', { timeout: 2000 }, () => {
    const html = createBuildIndicatorElement(undefined)
    assert.equal(html, '', 'should return empty string for undefined commit')
  })

  it('returns empty string when commitShort is empty string', { timeout: 2000 }, () => {
    const html = createBuildIndicatorElement('')
    assert.equal(html, '', 'should return empty string for empty commit')
  })

  it('displays short hashes (< 7 chars) as-is', { timeout: 2000 }, () => {
    const html = createBuildIndicatorElement('abc12')
    assert.ok(html.includes('abc12'), 'should display short hash')
  })
})

describe('renderBuildIndicator', { timeout: 2000 }, () => {
  it('is an async function', { timeout: 2000 }, () => {
    assert.equal(typeof renderBuildIndicator, 'function')
  })

  it('fetches build info and returns HTML with the commit hash', { timeout: 2000 }, async () => {
    const fakeFetch = mockFetch(200, { commitShort: 'def5678' })
    const html = await renderBuildIndicator(fakeFetch)
    assert.equal(typeof html, 'string')
    assert.ok(html.includes('def5678'), 'should contain fetched commit hash')
  })

  it('returns empty string when API returns null commitShort', { timeout: 2000 }, async () => {
    const fakeFetch = mockFetch(200, { commitShort: null })
    const html = await renderBuildIndicator(fakeFetch)
    assert.equal(html, '', 'should be empty when no commit available')
  })

  it('returns empty string when API call fails', { timeout: 2000 }, async () => {
    const fakeFetch = mockFetch(500, { error: 'Server error' })
    const html = await renderBuildIndicator(fakeFetch)
    assert.equal(html, '', 'should gracefully degrade on API failure')
  })

  it('returns empty string when fetch throws a network error', { timeout: 2000 }, async () => {
    const failingFetch = async () => { throw new Error('Network error') }
    const html = await renderBuildIndicator(failingFetch)
    assert.equal(html, '', 'should gracefully degrade on network error')
  })
})
