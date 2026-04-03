import {
  getGameState,
  placeBid as apiBid,
  playCard as apiPlay,
  submitBlindNilExchange as apiExchange,
  addBotToTable as apiAddBot,
} from '../api.js'
import { navigate } from '../router.js'
import { handSpreadHtml, handDiagramHtml, lastTrickHtml } from '../hand.js'
import { relSeats } from '../seatUtils.js'
import { HOLD_DURATIONS, detectCompletedTrick, trickHoldHtml } from '../trickHold.js'
import { createInputBlocker } from '../inputBlock.js'

const SUIT_SYMBOL = { spades: '\u2660', hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663' }
const RED_SUIT = new Set(['hearts', 'diamonds'])
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

function bidLabel(bid) {
  if (bid === null) return '?'
  if (bid === 'nil') return 'Nil'
  if (bid === 'blind_nil') return 'Blind Nil'
  return String(bid)
}

function seatInfoHtml(state, seat, label, isWinner = false) {
  const bid = state.bids[seat]
  const tricks = state.tricksWon[seat]
  const isActive = state.currentBidderSeat === seat || state.currentPlayerSeat === seat
  const activeCls = isActive ? ' seat-active' : ''
  const winnerCls = isWinner ? ' seat-winner' : ''
  return `
    <div class="seat-info${activeCls}${winnerCls}">
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
  let showLastTrick = false
  let pollTimer = null
  let acting = false
  let mounted = true
  let holdActive = false
  let holdTrick = null
  let holdTimer = null
  let queuedState = null
  const inputBlocker = createInputBlocker()

  function cleanup() {
    mounted = false
    clearTimeout(pollTimer)
    clearTimeout(holdTimer)
    if (appEl) appEl.classList.remove('app--game')
  }

  function startHold(trick) {
    holdActive = true
    holdTrick = trick
    queuedState = null
    clearTimeout(holdTimer)
    render()
    holdTimer = setTimeout(() => {
      holdActive = false
      holdTrick = null
      // Slice 2: also wait for the card-play animation before calling unblock().
      // For now the animation is stubbed, so unblock as soon as the hold expires.
      inputBlocker.unblock()
      if (queuedState !== null) {
        state = queuedState
        queuedState = null
      }
      render()
    }, HOLD_DURATIONS.normal)
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
        if (holdActive) {
          // Queue the update — apply it after the hold window expires
          queuedState = s
        } else {
          state = s
          render()
        }
      } catch (_) {
        // silent — retry on next poll
      }
      schedulePoll()
    }, 2000)
  }

  function renderWaiting() {
    const seats = state.seats || {}
    const SEAT_NAMES = ['north', 'east', 'south', 'west']
    const emptySeats = SEAT_NAMES.filter((s) => seats[s] === null)
    const rows = SEAT_NAMES.map((s) => {
      const occupied = seats[s] !== null
      const cls = occupied ? 'waiting-seat waiting-seat--taken' : 'waiting-seat waiting-seat--empty'
      const label = s.charAt(0).toUpperCase() + s.slice(1)
      const status = occupied ? (seats[s].startsWith('bot:') ? 'Bot' : 'Joined') : 'Empty'
      return `<div class="${cls}"><span>${esc(label)}</span><span class="waiting-seat-status">${status}</span></div>`
    }).join('')

    const fillBotsBtn = state.isHost && emptySeats.length > 0
      ? `<button class="btn-primary" id="fill-bots-btn">Fill with Bots (${emptySeats.length} seat${emptySeats.length !== 1 ? 's' : ''})</button>`
      : ''

    container.innerHTML = `
      <div class="game-screen">
        <div class="waiting-screen">
          <h2 class="waiting-title">Waiting for players\u2026</h2>
          <div class="waiting-seats">${rows}</div>
          <div class="form-error waiting-err" role="alert" aria-live="polite"></div>
          ${fillBotsBtn}
          <p class="auth-link"><a href="#/lobby">Leave table</a></p>
        </div>
      </div>`

    container.querySelector('#fill-bots-btn')?.addEventListener('click', async () => {
      const btn = container.querySelector('#fill-bots-btn')
      const errEl = container.querySelector('.waiting-err')
      btn.disabled = true
      btn.textContent = 'Adding bots\u2026'
      errEl.textContent = ''
      try {
        for (const s of emptySeats) {
          await apiAddBot({ tableId, seat: s, sessionId, playerId })
        }
        // Fetch updated state (game should have started)
        state = await getGameState({ tableId, sessionId, playerId })
        render()
        schedulePoll()
      } catch (err) {
        errEl.textContent = err.message || 'Failed to add bots.'
        btn.disabled = false
        btn.textContent = `Fill with Bots (${emptySeats.length} seat${emptySeats.length !== 1 ? 's' : ''})`
      }
    })
  }

  function render() {
    if (!state) return
    if (state.status === 'waiting') {
      renderWaiting()
      return
    }
    if (state.phase === 'game_over') {
      navigate(`#/game-over?tableId=${tableId}`)
      return
    }

    const seat = getSeatForPlayer(state.players, playerId)
    if (!seat) {
      container.innerHTML = '<div class="game-screen"><p class="game-msg">You are not seated at this table.</p></div>'
      return
    }

    // Dismiss last trick overlay at the start of each new hand
    if (state.completedTricks.length === 0) showLastTrick = false

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
      if (isMyPlayTurn && !inputBlocker.isBlocked()) return 'card-play'
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
            ${seatInfoHtml(state, rel.across, rel.across.charAt(0).toUpperCase() + rel.across.slice(1), holdActive && holdTrick?.winner === rel.across)}
          </div>
          <div class="table-middle">
            <div class="table-side table-left">
              ${seatInfoHtml(state, rel.left, rel.left.charAt(0).toUpperCase() + rel.left.slice(1), holdActive && holdTrick?.winner === rel.left)}
            </div>
            <div class="trick-wrap">
              ${holdActive ? trickHoldHtml(holdTrick, rel) : trickHtml(state, rel)}
              ${!holdActive && state.phase === 'playing' && state.completedTricks.length > 0
                ? '<button class="last-trick-btn" id="last-trick-btn">Last Trick</button>'
                : ''}
            </div>
            <div class="table-side table-right">
              ${seatInfoHtml(state, rel.right, rel.right.charAt(0).toUpperCase() + rel.right.slice(1), holdActive && holdTrick?.winner === rel.right)}
            </div>
          </div>
          <div class="table-bottom">
            ${seatInfoHtml(state, rel.me, 'You', holdActive && holdTrick?.winner === rel.me)}
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

        ${showLastTrick && state.completedTricks.length > 0
          ? lastTrickHtml(state.completedTricks[state.completedTricks.length - 1], rel)
          : ''}
      </div>`

    // Mode toggle
    container.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        handMode = btn.dataset.mode
        render()
      })
    })

    // Last trick button — show overlay
    container.querySelector('#last-trick-btn')?.addEventListener('click', () => {
      showLastTrick = true
      render()
    })

    // Last trick overlay — dismiss on backdrop click or close button
    container.querySelector('#last-trick-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'last-trick-overlay' || e.target.id === 'last-trick-close') {
        showLastTrick = false
        render()
      }
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
    const handIsInteractive = (isMyPlayTurn && !inputBlocker.isBlocked()) || isMyExchangeTurn
    if (handIsInteractive) {
      container.querySelectorAll('#hand-cards [data-suit]').forEach((el) => {
        el.addEventListener('click', async () => {
          const card = { suit: el.dataset.suit, rank: el.dataset.rank }

          if (isMyPlayTurn) {
            if (acting || inputBlocker.isBlocked()) return
            acting = true
            inputBlocker.block()
            clearTimeout(pollTimer)
            const prevState = state
            try {
              const s = await apiPlay({ tableId, card, sessionId, playerId })
              if (!mounted) return
              const completedTrick = detectCompletedTrick(prevState, s)
              state = s
              if (completedTrick) {
                // startHold owns the unblock() call — it fires when both the hold
                // window and any card-play animation (Slice 2) have completed.
                startHold(completedTrick)
              } else {
                inputBlocker.unblock()
                render()
              }
            } catch (err) {
              if (!mounted) return
              inputBlocker.unblock()
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
