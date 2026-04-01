import {
  getGameState,
  placeBid as apiBid,
  playCard as apiPlay,
  submitBlindNilExchange as apiExchange,
} from '../api.js'
import { navigate } from '../router.js'

const SUIT_SYMBOL = { spades: '\u2660', hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663' }
const RED_SUIT = new Set(['hearts', 'diamonds'])
const CW = ['north', 'east', 'south', 'west']
const PARTNER = { north: 'south', south: 'north', east: 'west', west: 'east' }
const TEAM = { north: 'ns', south: 'ns', east: 'ew', west: 'ew' }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getSeatForPlayer(players, playerId) {
  return Object.entries(players).find(([, pid]) => pid === playerId)?.[0] ?? null
}

// Returns seats from the current player's perspective:
//   me = bottom, right = clockwise neighbour, across = partner, left = counter-clockwise neighbour
function relSeats(seat) {
  const i = CW.indexOf(seat)
  return {
    me: CW[i],
    right: CW[(i + 1) % 4],
    across: CW[(i + 2) % 4],
    left: CW[(i + 3) % 4],
  }
}

function bidLabel(bid) {
  if (bid === null) return '?'
  if (bid === 'nil') return 'Nil'
  if (bid === 'blind_nil') return 'Blind Nil'
  return String(bid)
}

function cardHtml(card, extraCls) {
  const s = SUIT_SYMBOL[card.suit]
  const red = RED_SUIT.has(card.suit) ? ' card-red' : ''
  const cls = extraCls ? ` ${extraCls}` : ''
  return `<span class="card${red}${cls}" data-suit="${esc(card.suit)}" data-rank="${esc(card.rank)}">${esc(card.rank)}${s}</span>`
}

function seatInfoHtml(state, seat, label) {
  const bid = state.bids[seat]
  const tricks = state.tricksWon[seat]
  const isActive = state.currentBidderSeat === seat || state.currentPlayerSeat === seat
  const activeCls = isActive ? ' seat-active' : ''
  return `
    <div class="seat-info${activeCls}">
      <span class="seat-name">${esc(label)}</span>
      <div class="seat-stats">
        <span>Bid: ${esc(bidLabel(bid))}</span>
        <span>Tricks: ${tricks}</span>
      </div>
    </div>`
}

function trickHtml(state, rel) {
  const bySeats = {}
  for (const { seat, card } of state.currentTrick) bySeats[seat] = card

  function slot(seat) {
    const card = bySeats[seat]
    if (!card) return '<div class="trick-slot"></div>'
    const s = SUIT_SYMBOL[card.suit]
    const red = RED_SUIT.has(card.suit) ? ' trick-red' : ''
    return `<div class="trick-slot"><div class="trick-card${red}">${esc(card.rank)}${s}</div></div>`
  }

  return `
    <div class="trick-area">
      <div class="trick-row">${slot(rel.across)}</div>
      <div class="trick-row trick-middle">
        ${slot(rel.left)}
        <div class="trick-center"></div>
        ${slot(rel.right)}
      </div>
      <div class="trick-row">${slot(rel.me)}</div>
    </div>`
}

function handSpreadHtml(hand, extraClsFn) {
  return hand.map((card) => cardHtml(card, extraClsFn(card))).join('')
}

function handDiagramHtml(hand, extraClsFn) {
  const bySuit = { spades: [], hearts: [], diamonds: [], clubs: [] }
  for (const c of hand) bySuit[c.suit].push(c)

  return Object.entries(bySuit)
    .filter(([, cards]) => cards.length > 0)
    .map(([suit, cards]) => {
      const s = SUIT_SYMBOL[suit]
      const red = RED_SUIT.has(suit) ? ' suit-red' : ''
      const cardsHtml = cards.map((card) => cardHtml(card, `card-compact${extraClsFn(card) ? ' ' + extraClsFn(card) : ''}`)).join('')
      return `<div class="diagram-row"><span class="diagram-suit${red}">${s}</span>${cardsHtml}</div>`
    })
    .join('')
}

/**
 * Render the full game screen into `container`.
 * Polls the server every 2 seconds for state updates.
 *
 * @param {HTMLElement} container
 */
export function renderGameScreen(container) {
  const sessionId = sessionStorage.getItem('sessionId')
  const playerId = sessionStorage.getItem('playerId')
  if (!sessionId || !playerId) { navigate('#/login'); return }

  const params = new URLSearchParams(window.location.hash.split('?')[1] || '')
  const tableId = params.get('tableId')
  if (!tableId) { navigate('#/lobby'); return }

  const appEl = document.getElementById('app')
  if (appEl) appEl.classList.add('app--game')

  let state = null
  let handMode = 'spread'
  let selectedCards = []
  let pollTimer = null
  let acting = false
  let mounted = true

  function cleanup() {
    mounted = false
    clearTimeout(pollTimer)
    if (appEl) appEl.classList.remove('app--game')
  }
  window.addEventListener('hashchange', cleanup, { once: true })

  function schedulePoll() {
    clearTimeout(pollTimer)
    if (!mounted) return
    pollTimer = setTimeout(async () => {
      if (!mounted || acting) return
      try {
        const s = await getGameState({ tableId, sessionId, playerId })
        if (!mounted) return
        state = s
        render()
      } catch (_) {
        // silent — retry on next poll
      }
      schedulePoll()
    }, 2000)
  }

  function render() {
    if (!state) return
    if (state.phase === 'game_over') {
      navigate(`#/game-over?tableId=${tableId}`)
      return
    }

    const seat = getSeatForPlayer(state.players, playerId)
    if (!seat) {
      container.innerHTML = '<div class="game-screen"><p class="game-msg">You are not seated at this table.</p></div>'
      return
    }

    const rel = relSeats(seat)
    const isMyBidTurn = state.phase === 'bidding' && state.currentBidderSeat === seat
    const isMyPlayTurn = state.phase === 'playing' && state.currentPlayerSeat === seat
    const bne = state.blindNilExchange
    const isMyExchangeTurn = state.phase === 'blind_nil_exchange' && bne && (
      (bne.step === 'blind_to_partner' && bne.currentBlindNilSeat === seat) ||
      (bne.step === 'partner_to_blind' && PARTNER[bne.currentBlindNilSeat] === seat)
    )

    const selectedSet = new Set(selectedCards.map((c) => `${c.suit}-${c.rank}`))

    function cardExtraCls(card) {
      const key = `${card.suit}-${card.rank}`
      if (isMyPlayTurn) return 'card-play'
      if (isMyExchangeTurn) return selectedSet.has(key) ? 'card-sel' : 'card-exch'
      return ''
    }

    const handHtml = handMode === 'spread'
      ? handSpreadHtml(state.myHand, cardExtraCls)
      : `<div class="hand-diagram">${handDiagramHtml(state.myHand, cardExtraCls)}</div>`

    let statusMsg = ''
    if (state.phase === 'bidding') {
      statusMsg = isMyBidTurn ? 'Your turn to bid' : `Waiting for ${esc(state.currentBidderSeat)} to bid\u2026`
    } else if (state.phase === 'blind_nil_exchange') {
      statusMsg = isMyExchangeTurn
        ? (bne.step === 'blind_to_partner' ? 'Select 2 cards to send to your partner' : 'Select 2 cards to return to the Blind Nil player')
        : 'Waiting for blind nil card exchange\u2026'
    } else if (state.phase === 'playing') {
      statusMsg = isMyPlayTurn ? 'Your turn \u2014 click a card to play' : `Waiting for ${esc(state.currentPlayerSeat)} to play\u2026`
    }

    const myTeam = TEAM[seat]
    const oppTeam = myTeam === 'ns' ? 'ew' : 'ns'
    const blindNilEligible = (state.scores[oppTeam] - state.scores[myTeam]) >= 100

    const bidPanelHtml = isMyBidTurn ? `
      <div class="bid-panel">
        <p class="bid-title">Choose your bid:</p>
        <div class="bid-grid">
          ${Array.from({ length: 14 }, (_, i) => `<button class="bid-num-btn" data-bid="${i}">${i}</button>`).join('')}
        </div>
        <div class="bid-special-row">
          <button class="bid-special-btn" data-bid="nil">Nil</button>
          ${blindNilEligible ? '<button class="bid-special-btn bid-blind-nil-btn" data-bid="blind_nil">Blind Nil</button>' : ''}
        </div>
        <div class="form-error bid-err" role="alert" aria-live="polite"></div>
      </div>` : ''

    const exchangePanelHtml = isMyExchangeTurn ? `
      <div class="exchange-panel">
        <p class="exchange-hint">
          ${bne.step === 'blind_to_partner' ? 'Select 2 cards to give your partner' : 'Select 2 cards to return to the Blind Nil player'}
          (${selectedCards.length}/2 selected)
        </p>
        <button class="btn-primary exchange-btn" id="exchange-submit-btn" ${selectedCards.length === 2 ? '' : 'disabled'}>Send Cards</button>
        <div class="form-error exchange-err" role="alert" aria-live="polite"></div>
      </div>` : ''

    container.innerHTML = `
      <div class="game-screen">
        <div class="game-scoreboard">
          <div class="score-team score-ns">
            <span class="score-team-label">N/S</span>
            <span class="score-pts">${state.scores.ns}</span>
            <span class="score-bags">${state.bags.ns} bag${state.bags.ns !== 1 ? 's' : ''}</span>
          </div>
          <div class="score-meta">Hand #${state.handNumber}${state.spadesbroken ? ' \u00b7 \u2660 broken' : ''}</div>
          <div class="score-team score-ew">
            <span class="score-team-label">E/W</span>
            <span class="score-pts">${state.scores.ew}</span>
            <span class="score-bags">${state.bags.ew} bag${state.bags.ew !== 1 ? 's' : ''}</span>
          </div>
        </div>

        <div class="game-table">
          <div class="table-top">
            ${seatInfoHtml(state, rel.across, rel.across.charAt(0).toUpperCase() + rel.across.slice(1))}
          </div>
          <div class="table-middle">
            <div class="table-side table-left">
              ${seatInfoHtml(state, rel.left, rel.left.charAt(0).toUpperCase() + rel.left.slice(1))}
            </div>
            ${trickHtml(state, rel)}
            <div class="table-side table-right">
              ${seatInfoHtml(state, rel.right, rel.right.charAt(0).toUpperCase() + rel.right.slice(1))}
            </div>
          </div>
          <div class="table-bottom">
            ${seatInfoHtml(state, rel.me, 'You')}
          </div>
        </div>

        <div class="game-status-bar">
          <span class="game-status-msg">${statusMsg}</span>
        </div>

        ${bidPanelHtml}
        ${exchangePanelHtml}

        <div class="game-hand-section">
          <div class="hand-mode-toggle">
            <button class="mode-btn${handMode === 'spread' ? ' mode-btn-active' : ''}" data-mode="spread">Spread</button>
            <button class="mode-btn${handMode === 'diagram' ? ' mode-btn-active' : ''}" data-mode="diagram">Diagram</button>
          </div>
          <div class="hand-cards" id="hand-cards">${handHtml}</div>
          <div class="form-error play-err" role="alert" aria-live="polite"></div>
        </div>
      </div>`

    // Mode toggle
    container.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        handMode = btn.dataset.mode
        render()
      })
    })

    // Bid buttons
    if (isMyBidTurn) {
      container.querySelectorAll('[data-bid]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (acting) return
          acting = true
          clearTimeout(pollTimer)
          const raw = btn.dataset.bid
          const bid = /^\d+$/.test(raw) ? Number(raw) : raw
          try {
            const s = await apiBid({ tableId, bid, sessionId, playerId })
            if (!mounted) return
            state = s
            selectedCards = []
            render()
          } catch (err) {
            if (!mounted) return
            const errEl = container.querySelector('.bid-err')
            if (errEl) errEl.textContent = err.message || 'Failed to place bid.'
          } finally {
            acting = false
            schedulePoll()
          }
        })
      })
    }

    // Hand card interactions (play or exchange)
    const handIsInteractive = isMyPlayTurn || isMyExchangeTurn
    if (handIsInteractive) {
      container.querySelectorAll('#hand-cards [data-suit]').forEach((el) => {
        el.addEventListener('click', async () => {
          const card = { suit: el.dataset.suit, rank: el.dataset.rank }

          if (isMyPlayTurn) {
            if (acting) return
            acting = true
            clearTimeout(pollTimer)
            try {
              const s = await apiPlay({ tableId, card, sessionId, playerId })
              if (!mounted) return
              state = s
              render()
            } catch (err) {
              if (!mounted) return
              const errEl = container.querySelector('.play-err')
              if (errEl) errEl.textContent = err.message || 'Cannot play that card.'
            } finally {
              acting = false
              schedulePoll()
            }
          } else if (isMyExchangeTurn) {
            const key = `${card.suit}-${card.rank}`
            const idx = selectedCards.findIndex((c) => `${c.suit}-${c.rank}` === key)
            if (idx >= 0) {
              selectedCards.splice(idx, 1)
            } else if (selectedCards.length < 2) {
              selectedCards.push(card)
            }
            render()
          }
        })
      })
    }

    // Exchange submit
    container.querySelector('#exchange-submit-btn')?.addEventListener('click', async () => {
      if (acting || selectedCards.length !== 2) return
      acting = true
      clearTimeout(pollTimer)
      try {
        const s = await apiExchange({ tableId, cards: [...selectedCards], sessionId, playerId })
        if (!mounted) return
        state = s
        selectedCards = []
        render()
      } catch (err) {
        if (!mounted) return
        const errEl = container.querySelector('.exchange-err')
        if (errEl) errEl.textContent = err.message || 'Failed to exchange cards.'
      } finally {
        acting = false
        schedulePoll()
      }
    })
  }

  // Initial load
  container.innerHTML = '<div class="game-screen"><p class="game-msg">Loading game\u2026</p></div>'
  getGameState({ tableId, sessionId, playerId }).then((s) => {
    if (!mounted) return
    state = s
    render()
    schedulePoll()
  }).catch((err) => {
    if (!mounted) return
    if (err.status === 401) { navigate('#/login'); return }
    if (err.status === 403) { navigate('#/lobby'); return }
    container.innerHTML = '<div class="game-screen"><p class="game-msg">Failed to load game. <a href="#/lobby">Back to lobby</a></p></div>'
  })
}
