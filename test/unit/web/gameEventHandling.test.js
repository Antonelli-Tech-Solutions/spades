import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GAME_REFRESH_EVENTS } from '../../../client/web/src/screens/game.js'

// ---------------------------------------------------------------------------
// GAME_REFRESH_EVENTS
// ---------------------------------------------------------------------------

describe('GAME_REFRESH_EVENTS', { timeout: 2000 }, () => {
  it('is exported as a Set', { timeout: 2000 }, () => {
    assert.ok(GAME_REFRESH_EVENTS instanceof Set, 'GAME_REFRESH_EVENTS should be a Set')
  })

  // PRD §6.4.3 in-game events — all must trigger a state refresh
  const requiredInGameEvents = [
    'HAND_DEALT',
    'BID_PLACED',
    'HAND_REVEALED',
    'BLIND_NIL_EXCHANGE_PROMPT',
    'CARD_PLAYED',
    'TRICK_COMPLETE',
    'HAND_SCORED',
    'GAME_OVER',
    'TURN_CHANGED',
    'PLAYER_DISCONNECTED',
    'PLAYER_RECONNECTED',
  ]

  for (const event of requiredInGameEvents) {
    it(`includes in-game event ${event}`, { timeout: 2000 }, () => {
      assert.ok(GAME_REFRESH_EVENTS.has(event), `${event} should trigger a state refresh`)
    })
  }

  // PRD §6.4.4 lobby/pre-game events — needed so the waiting-room phase stays live
  const requiredLobbyEvents = [
    'TABLE_UPDATED',
    'SEAT_TAKEN',
    'SEAT_VACATED',
    'GAME_STARTED',
  ]

  for (const event of requiredLobbyEvents) {
    it(`includes lobby/pre-game event ${event}`, { timeout: 2000 }, () => {
      assert.ok(GAME_REFRESH_EVENTS.has(event), `${event} should trigger a state refresh`)
    })
  }

  it('does not include WebSocket handshake events (JOINED, JOIN_DENIED)', { timeout: 2000 }, () => {
    assert.ok(!GAME_REFRESH_EVENTS.has('JOINED'), 'JOINED is consumed by createGameSocket internally')
    assert.ok(!GAME_REFRESH_EVENTS.has('JOIN_DENIED'), 'JOIN_DENIED is consumed by createGameSocket internally')
  })
})
