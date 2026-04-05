import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGameSocket, buildWsUrl } from '../../../client/web/src/gameSocket.js'

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

  it('calls onClose when the WebSocket closes', { timeout: 2000 }, () => {
    let closed = false
    createGameSocket({
      wsUrl: 'ws://localhost?sessionId=s1',
      tableId: 'table-abc',
      onClose: () => { closed = true },
      WebSocketClass: MockWebSocket,
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
