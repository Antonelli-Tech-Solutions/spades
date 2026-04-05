import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGameSocket, createLobbySocket, buildWsUrl } from '../../../client/web/src/gameSocket.js'

// --- Mock WebSocket -----------------------------------------------------------

class MockWebSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0 // CONNECTING
    this.sent = []
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    MockWebSocket.lastInstance = this
  }

  _open() {
    this.readyState = 1 // OPEN
    this.onopen?.()
  }

  _receive(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  _close(code) {
    this.readyState = 3 // CLOSED
    this.onclose?.(code)
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 2 // CLOSING
  }
}

// --- createGameSocket --------------------------------------------------------

describe('createGameSocket', { timeout: 2000 }, () => {
  it('creates a WebSocket connection to the given URL', { timeout: 2000 }, () => {
    const { close } = createGameSocket({
      wsUrl: 'ws://localhost:3001?sessionId=sess-1',
      tableId: 'table-abc',
      WebSocketClass: MockWebSocket,
    })
    assert.equal(MockWebSocket.lastInstance.url, 'ws://localhost:3001?sessionId=sess-1')
    close()
  })

  it('sends JOIN message once the WebSocket opens', { timeout: 2000 }, () => {
    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'my-table',
      WebSocketClass: MockWebSocket,
    })
    MockWebSocket.lastInstance._open()
    const sent = MockWebSocket.lastInstance.sent
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'JOIN')
    assert.equal(sent[0].payload.tableId, 'my-table')
  })

  it('calls onOpen when JOINED ack is received for the subscribed table', { timeout: 2000 }, () => {
    let opened = false
    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      onOpen: () => { opened = true },
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    ws._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })
    assert.equal(opened, true)
  })

  it('does not call onOpen for JOINED ack of a different table', { timeout: 2000 }, () => {
    let opened = false
    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      onOpen: () => { opened = true },
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    ws._receive({ type: 'JOINED', payload: { tableId: 'table-other' } })
    assert.equal(opened, false)
  })

  it('calls onEvent for non-handshake messages', { timeout: 2000 }, () => {
    const events = []
    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      onEvent: (msg) => events.push(msg),
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    ws._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } }) // handshake — not forwarded
    ws._receive({ type: 'CARD_PLAYED', payload: { seat: 'north', card: { suit: 'spades', rank: 'A' } } })
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'CARD_PLAYED')
  })

  it('does not forward JOINED or JOIN_DENIED to onEvent', { timeout: 2000 }, () => {
    const events = []
    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      onEvent: (msg) => events.push(msg),
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    ws._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })
    ws._receive({ type: 'JOIN_DENIED', payload: { tableId: 'table-abc', reason: 'not_seated' } })
    assert.equal(events.length, 0)
  })

  it('calls onClose when reconnect retries are exhausted', { timeout: 2000 }, () => {
    let closed = false
    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      onClose: () => { closed = true },
      WebSocketClass: MockWebSocket,
      // 0 retries so onClose fires on the very first unexpected close
      maxReconnectAttempts: 0,
    })
    MockWebSocket.lastInstance._close()
    assert.equal(closed, true)
  })

  it('calls onError when the WebSocket fires an error', { timeout: 2000 }, () => {
    const errors = []
    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      onError: (e) => errors.push(e),
      WebSocketClass: MockWebSocket,
    })
    const fakeErr = new Error('connection refused')
    MockWebSocket.lastInstance.onerror(fakeErr)
    assert.equal(errors.length, 1)
    assert.equal(errors[0], fakeErr)
  })

  it('sends LEAVE and closes the WebSocket when close() is called on an open connection', { timeout: 2000 }, () => {
    const { close } = createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    ws._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })
    close()
    const leaveMsg = ws.sent.find((m) => m.type === 'LEAVE')
    assert.ok(leaveMsg, 'LEAVE message should be sent on close')
    assert.equal(leaveMsg.payload.tableId, 'table-abc')
    assert.ok(ws.readyState >= 2, 'WebSocket should be closing or closed')
  })

  it('does not send LEAVE if connection was never opened (CONNECTING state)', { timeout: 2000 }, () => {
    const { close } = createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      WebSocketClass: MockWebSocket,
    })
    // readyState is CONNECTING (0) — do not send LEAVE
    assert.doesNotThrow(() => close())
    const sent = MockWebSocket.lastInstance.sent
    const leaveMsg = sent.find((m) => m.type === 'LEAVE')
    assert.equal(leaveMsg, undefined)
  })

  it('close() is safe to call when connection is already closed', { timeout: 2000 }, () => {
    const { close } = createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      WebSocketClass: MockWebSocket,
    })
    MockWebSocket.lastInstance._close()
    assert.doesNotThrow(() => close())
  })

  it('ignores malformed (non-JSON) messages without throwing', { timeout: 2000 }, () => {
    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    assert.doesNotThrow(() => ws.onmessage?.({ data: 'not-json{{' }))
  })
})

// --- Reconnect ---------------------------------------------------------------

describe('createGameSocket reconnect', { timeout: 2000 }, () => {
  // Collect all MockWebSocket instances created during a test so we can
  // simulate the reconnect WebSocket independently.
  class TrackingWebSocket extends MockWebSocket {
    constructor(url) {
      super(url)
      TrackingWebSocket.instances.push(this)
    }
    static reset() { TrackingWebSocket.instances = [] }
  }
  TrackingWebSocket.instances = []

  it('does not reconnect after intentional close()', { timeout: 2000 }, () => {
    TrackingWebSocket.reset()
    const timeouts = []
    const { close } = createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      WebSocketClass: TrackingWebSocket,
      setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length },
      clearTimeoutFn: () => {},
    })
    const ws = TrackingWebSocket.instances[0]
    ws._open()
    ws._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })
    close() // intentional
    ws._close()
    assert.equal(timeouts.length, 0, 'should not schedule reconnect after intentional close')
    assert.equal(TrackingWebSocket.instances.length, 1, 'should not create a new WebSocket')
  })

  it('schedules a reconnect after unexpected close', { timeout: 2000 }, () => {
    TrackingWebSocket.reset()
    const timeouts = []
    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      WebSocketClass: TrackingWebSocket,
      setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length },
      clearTimeoutFn: () => {},
    })
    const ws = TrackingWebSocket.instances[0]
    ws._open()
    ws._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })
    ws._close() // unexpected
    assert.equal(timeouts.length, 1, 'should schedule one reconnect attempt')
  })

  it('uses exponential backoff for reconnect delays', { timeout: 2000 }, () => {
    TrackingWebSocket.reset()
    const timeouts = []
    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      WebSocketClass: TrackingWebSocket,
      setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length },
      clearTimeoutFn: () => {},
    })

    // Initial connect succeeds, then disconnects unexpectedly
    TrackingWebSocket.instances[0]._open()
    TrackingWebSocket.instances[0]._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })
    TrackingWebSocket.instances[0]._close()
    // → delay = 1000 * 2^0 = 1000ms, reconnectAttempts = 1

    // Fire reconnect — but DO NOT receive JOINED so the counter keeps climbing
    timeouts[0].fn()
    TrackingWebSocket.instances[1]._open()
    TrackingWebSocket.instances[1]._close()
    // → delay = 1000 * 2^1 = 2000ms, reconnectAttempts = 2

    timeouts[1].fn()
    TrackingWebSocket.instances[2]._open()
    TrackingWebSocket.instances[2]._close()
    // → delay = 1000 * 2^2 = 4000ms, reconnectAttempts = 3

    const delays = timeouts.map((t) => t.ms)
    assert.ok(delays[1] > delays[0], 'second delay should be larger than first')
    assert.ok(delays[2] > delays[1], 'third delay should be larger than second')
  })

  it('calls onReconnect (not onOpen) when rejoining after a disconnect', { timeout: 2000 }, () => {
    TrackingWebSocket.reset()
    const timeouts = []
    let openCount = 0
    let reconnectCount = 0

    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      onOpen: () => { openCount++ },
      onReconnect: async () => { reconnectCount++ },
      WebSocketClass: TrackingWebSocket,
      setTimeoutFn: (fn, ms) => { timeouts.push(fn); return timeouts.length },
      clearTimeoutFn: () => {},
    })

    // Initial connect
    TrackingWebSocket.instances[0]._open()
    TrackingWebSocket.instances[0]._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })
    assert.equal(openCount, 1)
    assert.equal(reconnectCount, 0)

    // Unexpected close → reconnect
    TrackingWebSocket.instances[0]._close()
    timeouts[0]() // fire reconnect timeout

    // Second WS connects and gets JOINED ack
    TrackingWebSocket.instances[1]._open()
    TrackingWebSocket.instances[1]._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })
    assert.equal(openCount, 1, 'onOpen should not fire again on reconnect')
    assert.equal(reconnectCount, 1, 'onReconnect should fire on the reconnect JOINED ack')
  })

  it('buffers events received during onReconnect rehydration and flushes them after', { timeout: 2000 }, async () => {
    TrackingWebSocket.reset()
    const timeouts = []
    const receivedEvents = []
    let resolveReconnect

    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      onEvent: (msg) => receivedEvents.push(msg),
      onReconnect: () => new Promise((res) => { resolveReconnect = res }),
      WebSocketClass: TrackingWebSocket,
      setTimeoutFn: (fn, ms) => { timeouts.push(fn); return timeouts.length },
      clearTimeoutFn: () => {},
    })

    // Initial connect
    TrackingWebSocket.instances[0]._open()
    TrackingWebSocket.instances[0]._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })

    // Unexpected disconnect
    TrackingWebSocket.instances[0]._close()
    timeouts[0]() // fire reconnect

    // Reconnected
    TrackingWebSocket.instances[1]._open()
    TrackingWebSocket.instances[1]._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })
    // onReconnect is now in-flight (promise not yet resolved)

    // Events arriving while rehydration is in-flight — should be buffered
    TrackingWebSocket.instances[1]._receive({ type: 'CARD_PLAYED', payload: { seat: 'north' } })
    TrackingWebSocket.instances[1]._receive({ type: 'TURN_CHANGED', payload: { activeSeat: 'east' } })
    assert.equal(receivedEvents.length, 0, 'events should be buffered while onReconnect is in-flight')

    // Resolve rehydration
    resolveReconnect()
    // Allow the microtask queue to drain
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(receivedEvents.length, 2, 'buffered events should be flushed after onReconnect resolves')
    assert.equal(receivedEvents[0].type, 'CARD_PLAYED')
    assert.equal(receivedEvents[1].type, 'TURN_CHANGED')
  })

  it('stops reconnecting after maxReconnectAttempts', { timeout: 2000 }, () => {
    TrackingWebSocket.reset()
    const timeouts = []
    let closeCount = 0

    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      onClose: () => { closeCount++ },
      WebSocketClass: TrackingWebSocket,
      setTimeoutFn: (fn, ms) => { timeouts.push(fn); return timeouts.length },
      clearTimeoutFn: () => {},
      maxReconnectAttempts: 2,
    })

    // Initial connect succeeds, then disconnects unexpectedly
    TrackingWebSocket.instances[0]._open()
    TrackingWebSocket.instances[0]._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })
    TrackingWebSocket.instances[0]._close() // → attempt 1 scheduled, reconnectAttempts=1

    // Attempt 1: fails without JOINED
    timeouts[0]()
    TrackingWebSocket.instances[1]._open()
    TrackingWebSocket.instances[1]._close() // → attempt 2 scheduled, reconnectAttempts=2

    // Attempt 2: fails without JOINED — reconnectAttempts now equals maxReconnectAttempts
    timeouts[1]()
    TrackingWebSocket.instances[2]._open()
    TrackingWebSocket.instances[2]._close() // → onClose fires, no more retries

    assert.equal(timeouts.length, 2, 'should stop scheduling reconnects after max attempts')
    assert.equal(closeCount, 1, 'onClose should fire once all retries are exhausted')
  })

  it('resets reconnect attempt counter after a successful reconnect', { timeout: 2000 }, () => {
    TrackingWebSocket.reset()
    const timeouts = []

    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      onReconnect: async () => {},
      WebSocketClass: TrackingWebSocket,
      setTimeoutFn: (fn, ms) => { timeouts.push(fn); return timeouts.length },
      clearTimeoutFn: () => {},
      maxReconnectAttempts: 2,
    })

    // Initial connect → disconnect → attempt 1 scheduled
    TrackingWebSocket.instances[0]._open()
    TrackingWebSocket.instances[0]._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })
    TrackingWebSocket.instances[0]._close()  // reconnectAttempts=1
    // Attempt 1 fails without JOINED so counter reaches 2
    timeouts[0]()
    TrackingWebSocket.instances[1]._open()
    TrackingWebSocket.instances[1]._close()  // reconnectAttempts=2 (maxReconnectAttempts)
    // Attempt 2 — succeeds with JOINED, counter resets to 0
    timeouts[1]()
    TrackingWebSocket.instances[2]._open()
    TrackingWebSocket.instances[2]._receive({ type: 'JOINED', payload: { tableId: 'table-abc' } })
    // reconnectAttempts is now 0 — a fresh disconnect should start a new backoff cycle
    TrackingWebSocket.instances[2]._close()
    assert.equal(timeouts.length, 3, 'should schedule reconnect again after counter was reset by successful rejoin')
  })
})

// --- buildWsUrl --------------------------------------------------------------

describe('buildWsUrl', { timeout: 2000 }, () => {
  it('returns a string starting with ws: or wss:', { timeout: 2000 }, () => {
    const url = buildWsUrl('my-session')
    assert.ok(url.startsWith('ws:') || url.startsWith('wss:'), `expected ws/wss URL, got: ${url}`)
  })

  it('includes sessionId as a query parameter', { timeout: 2000 }, () => {
    const url = buildWsUrl('session-abc-123')
    assert.ok(url.includes('sessionId=session-abc-123'), `expected sessionId in URL, got: ${url}`)
  })

  it('URL-encodes special characters in the session ID', { timeout: 2000 }, () => {
    const url = buildWsUrl('session with spaces')
    assert.ok(!url.includes(' '), 'URL should not contain unencoded spaces')
  })
})

// --- createLobbySocket -------------------------------------------------------

describe('createLobbySocket', { timeout: 2000 }, () => {
  it('creates a WebSocket connection to the given URL', { timeout: 2000 }, () => {
    const { close } = createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=sess-1',
      WebSocketClass: MockWebSocket,
    })
    assert.equal(MockWebSocket.lastInstance.url, 'ws://localhost?sessionId=sess-1')
    close()
  })

  it('sends JOIN_LOBBY once the WebSocket opens', { timeout: 2000 }, () => {
    createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      WebSocketClass: MockWebSocket,
    })
    MockWebSocket.lastInstance._open()
    const sent = MockWebSocket.lastInstance.sent
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'JOIN_LOBBY')
  })

  it('calls onOpen when JOINED_LOBBY is received', { timeout: 2000 }, () => {
    let opened = false
    createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      onOpen: () => { opened = true },
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    ws._receive({ type: 'JOINED_LOBBY', payload: {} })
    assert.equal(opened, true)
  })

  it('calls onEvent for TABLE_CREATED events', { timeout: 2000 }, () => {
    const events = []
    createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      onEvent: (msg) => events.push(msg),
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    ws._receive({ type: 'JOINED_LOBBY', payload: {} })
    ws._receive({ type: 'TABLE_CREATED', payload: { tableId: 'tbl-1' } })
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'TABLE_CREATED')
  })

  it('calls onEvent for TABLE_UPDATED events', { timeout: 2000 }, () => {
    const events = []
    createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      onEvent: (msg) => events.push(msg),
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    ws._receive({ type: 'JOINED_LOBBY', payload: {} })
    ws._receive({ type: 'TABLE_UPDATED', payload: { tableId: 'tbl-1', visibility: 'public' } })
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'TABLE_UPDATED')
  })

  it('calls onEvent for TABLE_REMOVED events', { timeout: 2000 }, () => {
    const events = []
    createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      onEvent: (msg) => events.push(msg),
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    ws._receive({ type: 'JOINED_LOBBY', payload: {} })
    ws._receive({ type: 'TABLE_REMOVED', payload: { tableId: 'tbl-1' } })
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'TABLE_REMOVED')
  })

  it('does not forward JOINED_LOBBY or LEFT_LOBBY to onEvent', { timeout: 2000 }, () => {
    const events = []
    createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      onEvent: (msg) => events.push(msg),
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    ws._receive({ type: 'JOINED_LOBBY', payload: {} })
    ws._receive({ type: 'LEFT_LOBBY', payload: {} })
    assert.equal(events.length, 0)
  })

  it('close() sends LEAVE_LOBBY when connection is open', { timeout: 2000 }, () => {
    const { close } = createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    ws._receive({ type: 'JOINED_LOBBY', payload: {} })
    close()
    const leaveMsg = ws.sent.find((m) => m.type === 'LEAVE_LOBBY')
    assert.ok(leaveMsg, 'LEAVE_LOBBY message should be sent on close')
    assert.ok(ws.readyState >= 2, 'WebSocket should be closing or closed')
  })

  it('close() does not send LEAVE_LOBBY when connection is not yet open', { timeout: 2000 }, () => {
    const { close } = createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      WebSocketClass: MockWebSocket,
    })
    // readyState is CONNECTING (0) — should not send LEAVE_LOBBY
    assert.doesNotThrow(() => close())
    const leaveMsg = MockWebSocket.lastInstance.sent.find((m) => m.type === 'LEAVE_LOBBY')
    assert.equal(leaveMsg, undefined)
  })

  it('close() is safe to call when connection is already closed', { timeout: 2000 }, () => {
    const { close } = createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      WebSocketClass: MockWebSocket,
    })
    MockWebSocket.lastInstance._close()
    assert.doesNotThrow(() => close())
  })

  it('calls onClose when the socket closes', { timeout: 2000 }, () => {
    let closed = false
    createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      onClose: () => { closed = true },
      WebSocketClass: MockWebSocket,
    })
    MockWebSocket.lastInstance._close()
    assert.equal(closed, true)
  })

  it('calls onError when the WebSocket fires an error', { timeout: 2000 }, () => {
    const errors = []
    createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      onError: (e) => errors.push(e),
      WebSocketClass: MockWebSocket,
    })
    const fakeErr = new Error('connection refused')
    MockWebSocket.lastInstance.onerror(fakeErr)
    assert.equal(errors.length, 1)
    assert.equal(errors[0], fakeErr)
  })

  it('ignores malformed messages without throwing', { timeout: 2000 }, () => {
    createLobbySocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      WebSocketClass: MockWebSocket,
    })
    const ws = MockWebSocket.lastInstance
    ws._open()
    assert.doesNotThrow(() => ws.onmessage?.({ data: 'not-json{{' }))
  })
})
