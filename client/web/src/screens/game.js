import {
  getGameState,
  placeBid as apiBid,
  playCard as apiPlay,
  submitBlindNilExchange as apiExchange,
  addBotToTable as apiAddBot,
  revealHand as apiRevealHand,
  terminateGame as apiTerminate,
  leaveTable as apiLeaveTable,
} from '../api.js'
import { createGameSocket, buildWsUrl } from '../gameSocket.js'
import { navigate } from '../router.js'
import { handSpreadHtml, handDiagramHtml, lastTrickHtml } from '../hand.js'
import { relSeats } from '../seatUtils.js'
import { HOLD_DURATIONS, detectCompletedTrick, isHandTransition, trickHoldHtml } from '../trickHold.js'
import { createInputBlocker } from '../inputBlock.js'
import { endOfHandSummaryHtml } from '../endOfHandSummary.js'
import { BAG_ICON } from '../icons.js'

const SUIT_SYMBOL = { spades: '\u2660', hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663' }
const RED_SUIT = new Set(['hearts', 'diamonds'])
const PARTNER = { north: 'south', south: 'north', east: 'west', west: 'east' }

/**
 * Set of WebSocket event types that should trigger a full state refresh and
 * re-render. Covers all PRD §6.4.3 in-game events and §6.4.4 lobby/pre-game
 * events so the waiting-room phase stays live without polling.
 */
export const GAME_REFRESH_EVENTS = new Set([
  // In-game events (PRD §6.4.3)
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
  // Lobby/pre-game events (PRD §6.4.4) — needed for waiting-room phase
  'TABLE_UPDATED',
  'SEAT_TAKEN',
  'SEAT_VACATED',
  'GAME_STARTED',
])
const TEAM = { north: 'ns', south: 'ns', east: 'ew', west: 'ew' }

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render 13 face-down card backs for the Blind Nil eligibility window.
 * @returns {string} HTML string
 */
export function blindNilHandHtml() {
  return Array.from({ length: 13 }, () => '<span class="card card-back"></span>').join('')
}

/**
 * Render the Blind Nil choice panel shown when it is the player's bid turn
 * and their hand is still hidden (blindNilEligible and no myHand).
 * @returns {string} HTML string
 */
export function blindNilChoicePanelHtml() {
  return `
    <div class="blind-nil-choice-panel">
      <p class="blind-nil-choice-title">Choose your action:</p>
      <div class="blind-nil-choice-btns">
        <button class="btn-primary blind-nil-reveal-btn" id="blind-nil-reveal-btn">Reveal Hand</button>
        <button class="btn-secondary blind-nil-bid-btn" id="blind-nil-bid-btn">Bid Blind Nil</button>
      </div>
      <div class="form-error blind-nil-err" role="alert" aria-live="polite"></div>
    </div>`
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

/**
 * Computes the bid contribution hint for the second bidder.
 * @param {number} teamTotal - The combined team target being considered
 * @param {number} partnerBid - The first bidder's already-placed numeric bid
 * @returns {{ yourBid: number, isWarning: boolean }}
 */
export function bidContributionHint(teamTotal, partnerBid) {
  return {
    yourBid: teamTotal - partnerBid,
    isWarning: teamTotal < partnerBid,
  }
}

/**
 * Renders the post-bid team summary bar once both players on a team have bid.
 * Nil and Blind Nil bids are excluded from the combined team total.
 * Returns an empty string if bidding is not yet complete for either team.
 * @param {{ bids: object, teamBids: object, biddingOrder: string[] }} state
 * @returns {string}
 */
export function teamBidSummaryHtml(state) {
  const teams = [
    { label: 'N/S', seats: ['north', 'south'], teamKey: 'ns' },
    { label: 'E/W', seats: ['east', 'west'], teamKey: 'ew' },
  ]

  const bars = []
  for (const { label, seats, teamKey } of teams) {
    const [a, b] = seats
    const bidA = state.bids[a]
    const bidB = state.bids[b]
    if (bidA === null || bidA === undefined || bidB === null || bidB === undefined) continue

    const isSpecialA = bidA === 'nil' || bidA === 'blind_nil'
    const isSpecialB = bidB === 'nil' || bidB === 'blind_nil'
    const nameA = a.charAt(0).toUpperCase() + a.slice(1)
    const nameB = b.charAt(0).toUpperCase() + b.slice(1)

    let summary
    if (!isSpecialA && !isSpecialB) {
      // Use the authoritative team total from the server; the second bidder's stored
      // bid value is the team total, not their individual contribution.

      // Fall back to the second bidder's stored bid when teamBids hasn't been
      // populated yet (i.e. the other team hasn't finished bidding).
      const biddingOrder = state.biddingOrder || []
      const [firstSeat, secondSeat] = biddingOrder.filter((s) => s === a || s === b)
      const resolvedFirst = firstSeat ?? a
      const resolvedSecond = secondSeat ?? b
      const teamTotal = state.teamBids[teamKey] ?? state.bids[resolvedSecond]
      const firstName = resolvedFirst.charAt(0).toUpperCase() + resolvedFirst.slice(1)
      const secondName = resolvedSecond.charAt(0).toUpperCase() + resolvedSecond.slice(1)
      const firstBid = state.bids[resolvedFirst]
      const secondIndividual = teamTotal - firstBid
      summary = `${esc(label)}: ${teamTotal} \u2014 ${esc(firstName)} ${firstBid}, ${esc(secondName)} ${secondIndividual}`
    } else {
      summary = `${esc(label)}: ${esc(nameA)} ${esc(bidLabel(bidA))}, ${esc(nameB)} ${esc(bidLabel(bidB))}`
    }

    bars.push(`<div class="bid-summary-team">${summary}</div>`)
  }

  if (bars.length === 0) return ''
  return `<div class="bid-summary">${bars.join('')}</div>`
}

/**
 * Returns the bid to display for a seat, taking partnership bidding into account.
 * For the second bidder in a numeric partnership, state.bids[seat] holds the team
 * total, not the player's individual contribution. This function converts it back.
 * @param {{ bids: object, biddingOrder: string[] }} state
 * @param {string} seat
 * @returns {number|string|null}
 */
export function getDisplayBid(state, seat) {
  const bid = state.bids[seat]
  if (typeof bid !== 'number') return bid

  const partner = PARTNER[seat]
  const partnerBid = state.bids[partner]
  if (typeof partnerBid !== 'number') return bid

  const biddingOrder = state.biddingOrder || []
  const teamPair = new Set([seat, partner])
  const orderedTeam = biddingOrder.filter((s) => teamPair.has(s))

  if (orderedTeam.length === 2 && orderedTeam[1] === seat) {
    // Second bidder stores the team total as their bid value.
    // Show individual contribution instead.
    return bid - partnerBid
  }

  return bid
}

function seatInfoHtml(state, seat, label, isWinner = false) {
  const bid = getDisplayBid(state, seat)
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
 * Game state updates are driven by incoming WebSocket events — no polling.
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
  let handMode = 'diagram'
  let selectedCards = []
  let showLastTrick = false
  let acting = false
  let mounted = true
  let holdActive = false
  let holdTrick = null
  let holdTimer = null
  let queuedState = null
  let dismissedHandCount = 0
  let gameSocket = null
  const inputBlocker = createInputBlocker()

  function cleanup() {
    mounted = false
    clearTimeout(holdTimer)
    gameSocket?.close()
    gameSocket = null
    if (appEl) appEl.classList.remove('app--game')
    sessionStorage.removeItem('currentTableId')
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
      // Slice 2 hook: move inputBlocker.unblock() inside the animation-complete
      // promise when card-play animations ship.
      inputBlocker.unblock()
      if (queuedState !== null) {
        state = queuedState
        queuedState = null
      }
      render()
    }, HOLD_DURATIONS.normal)
  }
  window.addEventListener('hashchange', cleanup, { once: true })

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

    const terminateBtn = state.isHost
      ? `<button class="btn-danger" id="terminate-btn">Terminate Game</button>`
      : ''

    container.innerHTML = `
      <div class="game-screen">
        <div class="waiting-screen">
          <h2 class="waiting-title">Waiting for players\u2026</h2>
          <div class="waiting-seats">${rows}</div>
          <div class="form-error waiting-err" role="alert" aria-live="polite"></div>
          ${fillBotsBtn}
          ${terminateBtn}
          <button class="btn-secondary" id="leave-table-btn">Leave Table</button>
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
      } catch (err) {
        errEl.textContent = err.message || 'Failed to add bots.'
        btn.disabled = false
        btn.textContent = `Fill with Bots (${emptySeats.length} seat${emptySeats.length !== 1 ? 's' : ''})`
      }
    })

    container.querySelector('#terminate-btn')?.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to terminate this game? This cannot be undone.')) return
      const btn = container.querySelector('#terminate-btn')
      const errEl = container.querySelector('.waiting-err')
      btn.disabled = true
      try {
        await apiTerminate({ tableId, sessionId, playerId })
        cleanup()
        navigate('#/lobby')
      } catch (err) {
        errEl.textContent = err.message || 'Failed to terminate game.'
        btn.disabled = false
      }
    })

    container.querySelector('#leave-table-btn')?.addEventListener('click', async () => {
      const btn = container.querySelector('#leave-table-btn')
      const errEl = container.querySelector('.waiting-err')
      btn.disabled = true
      btn.textContent = 'Leaving\u2026'
      errEl.textContent = ''
      try {
        await apiLeaveTable({ tableId, sessionId, playerId })
        cleanup()
        navigate('#/lobby')
      } catch (err) {
        errEl.textContent = err.message || 'Failed to leave table.'
        btn.disabled = false
        btn.textContent = 'Leave Table'
      }
    })
  }

  function renderHandSummary(seat) {
    const entry = state.handHistory[state.handHistory.length - 1]
    const isGameOver = state.phase === 'game_over'
    const gameOverInfo = isGameOver ? { winner: state.winner } : null
    container.innerHTML = `<div class="game-screen">${endOfHandSummaryHtml(entry, seat, gameOverInfo)}</div>`
    if (isGameOver) {
      container.querySelector('#hand-summary-lobby')?.addEventListener('click', () => {
        cleanup()
        navigate('#/lobby')
      })
    } else {
      container.querySelector('#hand-summary-continue')?.addEventListener('click', () => {
        dismissedHandCount++
        render()
      })
    }
  }

  function render() {
    if (!state) return
    if (state.status === 'waiting') {
      renderWaiting()
      return
    }

    const seat = getSeatForPlayer(state.players, playerId)

    // Show the end-of-hand summary overlay after each completed hand.
    // The hold window (showing the last trick) finishes first; the summary appears
    // after. Each client dismisses independently — no server round-trip needed.
    if (!holdActive && (state.handHistory?.length ?? 0) > dismissedHandCount) {
      renderHandSummary(seat || 'north')
      return
    }

    if (state.phase === 'game_over' && !holdActive) {
      // Final hand summary was already dismissed (e.g. page reload after game ended).
      // Navigate directly to lobby — there is nothing left to show.
      // Guard on !holdActive: if the last trick is still being displayed in the hold
      // window we must not navigate yet — the hold timer will call render() again
      // after expiry, at which point the game-over hand summary will be shown first.
      navigate('#/lobby')
      return
    }
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
    const handHidden = state.blindNilEligible === true && !state.myHand

    function cardExtraCls(card) {
      const key = `${card.suit}-${card.rank}`
      if (isMyPlayTurn && !inputBlocker.isBlocked()) return 'card-play'
      if (isMyExchangeTurn) return selectedSet.has(key) ? 'card-sel' : 'card-exch'
      return ''
    }

    const handHtml = handHidden
      ? blindNilHandHtml()
      : (handMode === 'spread'
        ? handSpreadHtml(state.myHand, cardExtraCls)
        : `<div class="hand-diagram">${handDiagramHtml(state.myHand, cardExtraCls)}</div>`)

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

    const blindNilEligible = state.blindNilEligible === true

    const partnerSeat = PARTNER[seat]
    const partnerBid = state.bids[partnerSeat]
    const partnerHasBid = partnerBid !== null && partnerBid !== undefined
    const partnerHasNumericBid = partnerHasBid && typeof partnerBid === 'number'

    let bidPanelTitle = 'Choose your bid:'
    let bidPartnerInfoHtml = ''
    if (partnerHasBid) {
      if (partnerHasNumericBid) {
        bidPanelTitle = 'Team Total'
        bidPartnerInfoHtml = `<p class="bid-partner-info">Partner bid ${partnerBid} \u2014 enter team total:</p>`
      } else {
        bidPartnerInfoHtml = `<p class="bid-partner-info">Partner: ${esc(bidLabel(partnerBid))}</p>`
      }
    }

    const bidPanelHtml = isMyBidTurn
      ? (handHidden
        ? blindNilChoicePanelHtml()
        : `
      <div class="bid-panel">
        <p class="bid-title">${esc(bidPanelTitle)}</p>
        ${bidPartnerInfoHtml}
        <div class="bid-grid">
          ${Array.from({ length: 14 }, (_, i) => {
            if (!partnerHasNumericBid) return `<button class="bid-num-btn" data-bid="${i}">${i}</button>`
            const { yourBid, isWarning } = bidContributionHint(i, partnerBid)
            const tip = isWarning
              ? `\u26a0 Team target (${i}) is below partner\u2019s bid (${partnerBid}) \u2014 every trick above ${i} is a bag`
              : `You are bidding ${yourBid} (team total ${i} \u2212 partner\u2019s bid ${partnerBid})`
            return `<button class="bid-num-btn${isWarning ? ' bid-num-btn--warn' : ''}" data-bid="${i}" data-tooltip="${tip}">${i}</button>`
          }).join('')}
        </div>
        <div class="bid-special-row">
          <button class="bid-special-btn" data-bid="nil">Nil</button>
          ${blindNilEligible ? '<button class="bid-special-btn bid-blind-nil-btn" data-bid="blind_nil">Blind Nil</button>' : ''}
        </div>
        <div class="form-error bid-err" role="alert" aria-live="polite"></div>
      </div>`)
      : ''

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
            <span class="score-bags">${BAG_ICON} ${state.bags.ns} bag${state.bags.ns !== 1 ? 's' : ''}</span>
          </div>
          <div class="score-meta">Hand #${state.handNumber}${state.spadesbroken ? ' \u00b7 \u2660 broken' : ''}</div>
          <div class="score-team score-ew">
            <span class="score-team-label">E/W</span>
            <span class="score-pts">${state.scores.ew}</span>
            <span class="score-bags">${BAG_ICON} ${state.bags.ew} bag${state.bags.ew !== 1 ? 's' : ''}</span>
          </div>
        </div>
        ${teamBidSummaryHtml(state)}

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
            <button class="mode-btn${handMode === 'diagram' ? ' mode-btn-active' : ''}" data-mode="diagram">Diagram</button>
            <button class="mode-btn${handMode === 'spread' ? ' mode-btn-active' : ''}" data-mode="spread">Spread</button>
          </div>
          <div class="hand-cards" id="hand-cards">${handHtml}</div>
          <div class="form-error play-err" role="alert" aria-live="polite"></div>
        </div>

        ${showLastTrick && state.completedTricks.length > 0
          ? lastTrickHtml(state.completedTricks[state.completedTricks.length - 1], rel)
          : ''}

        ${state.isHost ? '<div class="host-controls"><button class="btn-danger btn-sm" id="terminate-btn">Terminate Game</button></div>' : ''}
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

    // Terminate game button (host only, in-game)
    container.querySelector('#terminate-btn')?.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to terminate this game? This cannot be undone.')) return
      const btn = container.querySelector('#terminate-btn')
      btn.disabled = true
      try {
        await apiTerminate({ tableId, sessionId, playerId })
        cleanup()
        navigate('#/lobby')
      } catch (err) {
        btn.disabled = false
        console.log('Terminate failed:', { error: err.message })
      }
    })

    // Bid buttons
    if (isMyBidTurn) {
      container.querySelectorAll('[data-bid]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (acting) return
          acting = true
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
            const prevState = state
            try {
              const s = await apiPlay({ tableId, card, sessionId, playerId })
              if (!mounted) return
              const completedTrick = detectCompletedTrick(prevState, s)
              if (completedTrick) {
                // If this was the 13th trick of a non-final hand (state already
                // advanced to the next hand's bidding phase), keep rendering
                // prevState during the hold so the player sees the 13th trick in
                // context, not the new hand's bidding screen.
                if (!isHandTransition(prevState, s)) {
                  state = s
                }
                startHold(completedTrick)
                if (isHandTransition(prevState, s)) {
                  // startHold clears queuedState; override with new-hand state so
                  // the hold timer applies it after expiry.
                  queuedState = s
                }
                // inputBlocker stays blocked until the hold timer fires
              } else {
                state = s
                inputBlocker.unblock()
                render()
              }
            } catch (err) {
              inputBlocker.unblock()
              if (!mounted) return
              const errEl = container.querySelector('.play-err')
              if (errEl) errEl.textContent = err.message || 'Cannot play that card.'
            } finally {
              acting = false
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
      }
    })

    // Reveal Hand — call reveal-hand endpoint; state update will include myHand
    container.querySelector('#blind-nil-reveal-btn')?.addEventListener('click', async () => {
      if (acting) return
      acting = true
      try {
        const s = await apiRevealHand({ tableId, sessionId, playerId })
        if (!mounted) return
        state = s
        render()
      } catch (err) {
        if (!mounted) return
        const errEl = container.querySelector('.blind-nil-err')
        if (errEl) errEl.textContent = err.message || 'Failed to reveal hand.'
      } finally {
        acting = false
      }
    })

    // Bid Blind Nil directly — submit blind_nil bid without ever showing the hand
    container.querySelector('#blind-nil-bid-btn')?.addEventListener('click', async () => {
      if (acting) return
      acting = true
      try {
        const s = await apiBid({ tableId, bid: 'blind_nil', sessionId, playerId })
        if (!mounted) return
        state = s
        selectedCards = []
        render()
      } catch (err) {
        if (!mounted) return
        const errEl = container.querySelector('.blind-nil-err')
        if (errEl) errEl.textContent = err.message || 'Failed to place bid.'
      } finally {
        acting = false
      }
    })
  }

  // Initial load
  container.innerHTML = '<div class="game-screen"><p class="game-msg">Loading game\u2026</p></div>'
  getGameState({ tableId, sessionId, playerId }).then((s) => {
    if (!mounted) return
    state = s
    // On (re)load, skip any summaries for hands already completed before this session
    dismissedHandCount = s.handHistory?.length ?? 0
    render()

    // Establish authenticated WebSocket connection and subscribe to the table room.
    // All game and lobby events trigger a getGameState() fetch + re-render so that
    // every client stays in sync without a polling loop.
    gameSocket = createGameSocket({
      wsUrl: buildWsUrl(sessionId),
      tableId,
      onOpen: () => {
        console.log('GameSocket joined table room:', { tableId })
      },
      onEvent: async (msg) => {
        console.log('GameSocket event:', { type: msg.type, tableId })
        if (!mounted || acting) return
        if (!GAME_REFRESH_EVENTS.has(msg.type)) return
        try {
          const s = await getGameState({ tableId, sessionId, playerId })
          if (!mounted) return
          if (holdActive) {
            // Queue the update — apply it after the hold window expires
            queuedState = s
          } else {
            const prevState = state
            const completedTrick = detectCompletedTrick(prevState, s)
            if (completedTrick) {
              // A trick completed — trigger the hold so all players see the result.
              //
              // If this was the 13th trick of a non-final hand (handHistory grew
              // and state advanced to the next hand's bidding phase), keep rendering
              // prevState during the hold so the player sees the 13th trick in its
              // original hand context rather than the new hand's bidding screen.
              // For game_over the 13th trick is detected via completedTricks growth
              // (not reset), so state = s is safe there.
              if (!isHandTransition(prevState, s)) {
                state = s
              }
              startHold(completedTrick)
              if (isHandTransition(prevState, s)) {
                // startHold clears queuedState; override it with the new state so
                // the hold timer applies it after expiry.
                queuedState = s
              }
            } else {
              state = s
              render()
            }
          }
        } catch (err) {
          if (err.status === 404) {
            // Table was terminated — redirect to lobby
            cleanup()
            navigate('#/lobby')
            return
          }
          // silent — next event will trigger another refresh
        }
      },
      onClose: () => {
        console.log('GameSocket closed:', { tableId })
      },
      onError: (err) => {
        console.log('GameSocket error:', { tableId, error: err?.message })
      },
    })
  }).catch((err) => {
    if (!mounted) return
    if (err.status === 401) { navigate('#/login'); return }
    if (err.status === 403) { navigate('#/lobby'); return }
    container.innerHTML = '<div class="game-screen"><p class="game-msg">Failed to load game. <a href="#/lobby">Back to lobby</a></p></div>'
  })
}
