import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { observerRailHtml } from '../../../client/web/src/screens/game.js'

describe('observerRailHtml', { timeout: 2000 }, () => {
  it('returns "No spectators" placeholder for empty array', { timeout: 2000 }, () => {
    const html = observerRailHtml([], null)
    assert.ok(html.includes('observer-rail-empty'), 'should have observer-rail-empty class')
    assert.ok(html.includes('No spectators'), 'should show "No spectators" text')
  })

  it('returns "No spectators" placeholder for null', { timeout: 2000 }, () => {
    const html = observerRailHtml(null, null)
    assert.ok(html.includes('observer-rail-empty'), 'should have observer-rail-empty class')
    assert.ok(html.includes('No spectators'), 'should show "No spectators" text')
  })

  it('returns "No spectators" placeholder for undefined', { timeout: 2000 }, () => {
    const html = observerRailHtml(undefined, null)
    assert.ok(html.includes('observer-rail-empty'), 'should have observer-rail-empty class')
    assert.ok(html.includes('No spectators'), 'should show "No spectators" text')
  })

  it('renders a single observer name', { timeout: 2000 }, () => {
    const observers = [{ playerId: 'p1', username: 'Alice' }]
    const html = observerRailHtml(observers, null)
    assert.ok(html.includes('observer-rail'), 'should have observer-rail class')
    assert.ok(html.includes('<span class="observer-name">Alice</span>'), 'should render observer name in span')
  })

  it('joins multiple observer names with comma separator', { timeout: 2000 }, () => {
    const observers = [
      { playerId: 'p1', username: 'Alice' },
      { playerId: 'p2', username: 'Bob' },
      { playerId: 'p3', username: 'Charlie' },
    ]
    const html = observerRailHtml(observers, null)
    assert.ok(html.includes('Alice</span>, <span class="observer-name">Bob</span>, <span class="observer-name">Charlie</span>'),
      'should join names with ", " separator')
  })

  it('appends "(you)" badge when currentPlayerId matches an observer', { timeout: 2000 }, () => {
    const observers = [
      { playerId: 'p1', username: 'Alice' },
      { playerId: 'p2', username: 'Bob' },
    ]
    const html = observerRailHtml(observers, 'p1')
    assert.ok(html.includes('<span class="seat-you-badge">(you)</span>'), 'should include (you) badge')
    assert.ok(html.includes('Alice <span class="seat-you-badge">(you)</span>') ||
      html.includes('Alice</span>') === false,
      'badge should be associated with matching observer')
    // Bob should NOT have the badge
    assert.ok(!html.includes('Bob <span class="seat-you-badge">(you)</span>') &&
      !html.includes('Bob</span> <span class="seat-you-badge">'),
      'non-matching observer should not have (you) badge')
  })

  it('HTML-escapes usernames to prevent XSS', { timeout: 2000 }, () => {
    const observers = [{ playerId: 'p1', username: '<script>alert("xss")</script>' }]
    const html = observerRailHtml(observers, null)
    assert.ok(!html.includes('<script>'), 'should not contain raw <script> tag')
    assert.ok(html.includes('&lt;script&gt;'), 'should HTML-escape angle brackets')
  })
})
