import {
  getGameState,
  placeBid as apiBid,
  playCard as apiPlay,
  submitBlindNilExchange as apiExchange,
  addBotToTable as apiAddBot,
  revealHand as apiRevealHand,
  changeSeat as apiChangeSeat,
  leaveTable as apiLeaveTable,
} from '../api.js'
import { createGameSocket, buildWsUrl } from '../gameSocket.js'
import { navigate } from '../router.js'
import { handSpreadHtml, handDiagramHtml, lastTrickHtml } from '../hand.js'
import { relSeats } from '../seatUtils.js'
import { HOLD_DURATIONS, detectCompletedTrick, isHandTransition, trickHoldHtml } from '../trickHold.js'
import { createInputBlocker } from '../inputBlock.js'
import { endOfHandSummaryHtml } from '../endOfHandSummary.js'
import { BAG_ICON, CROWN_ICON } from '../icons.js'

const SUIT_SYMBOL = { spades: '\u2660', hearts: '\u2665', diamonds: '\u2666', clubs: '\u2663' }
const PARTNER = { north: 'south', south: 'north', east: 'west', west: 'east' }

/**
 * Structural transition events that require a full server state fetch.
 * These events change large amounts of state at once (e.g. new hand dealt,
 * hand scored, game over) where a delta is insufficient.
 */
export const FULL_REFRESH_EVENTS = new Set([
  // In-game structural transitions (PRD §6.4.3)
  'HAND_DEALT',
  'HAND_SCORED',
  'GAME_OVER',
  // Lobby/pre-game events (PRD §6.4.4) — needed for waiting-room phase
  'GAME_STARTED',
  'TABLE_UPDATED',
  'SEAT_TAKEN',
  'SEAT_VACATED',
])

/**
 * In-flight game events that carry a delta payload describing exactly what
 * changed. The client applies the payload directly to state instead of
 * fetching the full server state. Server emitters must include the fields
 * listed in the issue #239 hybrid spec for each event type.
 */
export const DELTA_EVENTS = new Set([
  'CARD_PLAYED',         // { seat, card, currentTrick, nextPlayerSeat, spadesBroken }
  'BID_PLACED',          // { seat, bidType[, bid] }
  'TRICK_COMPLETE',      // { winnerSeat, plays, tricksWon }
  'TURN_CHANGED',        // { activeSeat, phase }
  'HAND_REVEALED',       // { myHand, seat }
  'BLIND_NIL_EXCHANGE_PROMPT', // { direction, count, step, currentBlindNilSeat }
  'PLAYER_DISCONNECTED', // { seat, reconnectWindowSeconds }
  'PLAYER_RECONNECTED',  // { seat }
])

/**
 * Union of FULL_REFRESH_EVENTS and DELTA_EVENTS.
 * Kept for backward compatibility — any event in this set causes the game
 * screen to update (either via delta or full fetch).
 */
export const GAME_REFRESH_EVENTS = new Set([...FULL_REFRESH_EVENTS, ...DELTA_EVENTS])

/**
 * Returns the HTML for the in-game Leave Game button.
 * Exported for unit testing.
 */
export function leaveGameButtonHtml() {
  return `<button class="btn-secondary btn-sm" id="leave-game-btn">Leave Game</button>`
}

/**
 * Apply a WebSocket delta event payload directly to the current game state,
 * returning a new state object. For events whose payload does not carry enough
 * data to update state (e.g. old server without delta fields), the original
 * state reference is returned unchanged.
 *
 * @param {object|null} state - Current client-side game state
 * @param {{ type: string, payload: object }} msg - WebSocket message
 * @param {string} playerId - The current player's ID (used to detect own cards)
 * @returns {object|null} Updated state (new object) or original state if no change
 */
export function applyDelta(state, msg, playerId) {
  if (!state) return state
  const { type, payload } = msg

  switch (type) {
    case 'CARD_PLAYED': {
      const { seat, card, currentTrick, nextPlayerSeat, spadesBroken } = payload
      let myHand = state.myHand
      if (myHand && state.players) {
        const mySeat = Object.entries(state.players).find(([, id]) => id === playerId)?.[0]
        if (seat === mySeat) {
          const cardKey = `${card.suit}-${card.rank}`
          myHand = myHand.filter((c) => `${c.suit}-${c.rank}` !== cardKey)
        }
      }
      return {
        ...state,
        currentTrick: currentTrick ?? state.currentTrick,
        currentPlayerSeat: nextPlayerSeat ?? state.currentPlayerSeat,
        spadesbroken: spadesBroken ?? state.spadesbroken,
        myHand,
      }
    }

    case 'BID_PLACED': {
      const { seat, bidType, bid } = payload
      let bidValue
      if (bidType === 'nil') bidValue = 'nil'
      else if (bidType === 'blindNil') bidValue = 'blind_nil'
      else if (bidType === 'number' && bid !== undefined) bidValue = bid
      else return state  // numeric bid without value — cannot apply delta
      return { ...state, bids: { ...state.bids, [seat]: bidValue } }
    }

    case 'TRICK_COMPLETE': {
      const { winnerSeat, plays, tricksWon } = payload
      const trick = { winner: winnerSeat, plays }
      // Prefer the authoritative tricksWon from the server payload (idempotent SET).
      // Fall back to local increment for backward compatibility with older servers.
      const newTricksWon = tricksWon
        ? { ...tricksWon }
        : { ...state.tricksWon, [winnerSeat]: (state.tricksWon[winnerSeat] ?? 0) + 1 }
      return {
        ...state,
        currentTrick: [],
        completedTricks: [...(state.completedTricks || []), trick],
        tricksWon: newTricksWon,
      }
    }

    case 'TURN_CHANGED': {
      const { activeSeat, phase } = payload
      const update = { ...state, phase }
      if (phase === 'bidding') {
        update.currentBidderSeat = activeSeat
        update.currentPlayerSeat = null
      } else if (phase === 'playing') {
        update.currentPlayerSeat = activeSeat
        update.currentBidderSeat = null
      }
      return update
    }

    case 'HAND_REVEALED':
      return { ...state, myHand: payload.myHand, blindNilEligible: false }

    case 'BLIND_NIL_EXCHANGE_PROMPT': {
      const { step, currentBlindNilSeat } = payload
      if (step === undefined || currentBlindNilSeat === undefined) return state
      return {
        ...state,
        phase: 'blind_nil_exchange',
        blindNilExchange: { ...(state.blindNilExchange || {}), step, currentBlindNilSeat },
      }
    }

    case 'PLAYER_DISCONNECTED':
    case 'PLAYER_RECONNECTED':
      return state  // no state change — re-render for visual update only

    default:
      return state
  }
}
const TEAM = { north: 'ns', south: 'ns', east: 'ew', west: 'ew' }

/**
 * Determine the CSS modifier class for the tricks-taken count based on bid progress.
 *
 * Priority (highest → lowest):
 *   bid-tricks--met        : tricks >= bid (team already made their bid)
 *   bid-tricks--impossible : tricks + remaining < bid (cannot make bid)
 *   bid-tricks--needs-all  : tricks + remaining === bid (must win every remaining trick)
 *   ''                     : still achievable with tricks to spare
 *
 * @param {number|null|undefined} bid - Team's bid target
 * @param {number} tricks - Tricks taken so far this hand
 * @param {number} completedCount - Number of tricks completed so far (0–13)
 * @returns {string} CSS class modifier (without leading space)
 */
export function tricksCountClass(bid, tricks, completedCount) {
  if (typeof bid !== 'number') return ''
  if (tricks >= bid) return 'bid-tricks--met'
  const remaining = 13 - completedCount
  if (tricks + remaining < bid) return 'bid-tricks--impossible'
  if (tricks + remaining === bid) return 'bid-tricks--needs-all'
  return ''
}

/**
 * Render the team bid target and current tricks bar shown below the scoreboard during play.
 * Provides a quick at-a-glance view: each team's bid target vs. tricks taken this hand.
 * @param {object} state
 * @returns {string} HTML string
 */
export function teamBidTricksHtml(state) {
  const teams = [
    { label: 'N/S', key: 'ns', seats: ['north', 'south'] },
    { label: 'E/W', key: 'ew', seats: ['east', 'west'] },
  ]

  // Between CARD_PLAYED (4th card) and TRICK_COMPLETE, state.completedTricks and
  // state.tricksWon are both stale by one trick. Account for an in-flight complete
  // trick so the indicator stays accurate during that brief window.
  // currentPlayerSeat holds the trick winner for tricks 1–12 (set by the CARD_PLAYED
  // handler from nextPlayerSeat). On trick 13 nextPlayerSeat is null so
  // currentPlayerSeat is not updated — skip the winner credit in that case.
  const currentTrickLen = state.currentTrick?.length ?? 0
  const inFlightComplete = currentTrickLen >= 4 ? 1 : 0
  const completedCount = (state.completedTricks?.length ?? 0) + inFlightComplete
  const priorCompleted = state.completedTricks?.length ?? 0
  const inferredWinner = (inFlightComplete && priorCompleted < 12) ? (state.currentPlayerSeat ?? null) : null

  const cols = teams.map(({ label, key, seats }) => {
    const bid = state.teamBids?.[key]
    let tricks = (state.tricksWon?.[seats[0]] ?? 0) + (state.tricksWon?.[seats[1]] ?? 0)
    if (inferredWinner && seats.includes(inferredWinner)) {
      tricks++
    }
    const bidDisplay = bid !== null && bid !== undefined ? bid : '–'
    const cls = tricksCountClass(bid, tricks, completedCount)
    const tricksCls = cls ? ` ${cls}` : ''
    return `<div class="bid-tricks-team">
      <span class="bid-tricks-label">${esc(label)}</span>
      <span class="bid-tricks-target">Bid <strong>${bidDisplay}</strong></span>
      <span class="bid-tricks-count${tricksCls}">Tricks <strong>${tricks}</strong></span>
    </div>`
  })

  return `<div class="bid-tricks-bar">${cols.join('<div class="bid-tricks-sep"></div>')}</div>`
}

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

/**
 * Returns the display name for a seat during an active game.
 * Uses playerNames from the game state if available, falling back to the
 * capitalized seat direction (e.g. "North").
 */
function seatDisplayName(state, seat) {
  const info = state.playerNames?.[seat]
  if (info) return info.isBot ? 'Bot' : (info.username ?? seat.charAt(0).toUpperCase() + seat.slice(1))
  return seat.charAt(0).toUpperCase() + seat.slice(1)
}

function seatInfoHtml(state, seat, label, isWinner = false) {
  const bid = getDisplayBid(state, seat)
  const tricks = state.tricksWon[seat]
  const isActive = state.currentBidderSeat === seat || state.currentPlayerSeat === seat
  const activeCls = isActive ? ' seat-active' : ''
  const winnerCls = isWinner ? ' seat-winner' : ''
  const crownHtml = state.hostSeat === seat ? `<span class="seat-host-crown" title="Host">${CROWN_ICON}</span>` : ''
  return `
    <div class="seat-info${activeCls}${winnerCls}">
      <span class="seat-name">${esc(label)}${crownHtml}</span>
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
    const colorCls = card.suit ? ` trick-${card.suit}` : ''
    return `<div class="trick-slot"><div class="trick-card${colorCls}">${esc(card.rank)}${s}</div></div>`
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
      const seatInfo = seats[s]
      const occupied = seatInfo !== null
      const cls = occupied ? 'waiting-seat waiting-seat--taken' : 'waiting-seat waiting-seat--empty'
      const label = s.charAt(0).toUpperCase() + s.slice(1)
      let status = 'Empty'
      if (occupied) {
        if (seatInfo.isBot) {
          status = '<span class="seat-bot-badge">BOT</span>'
        } else if (seatInfo.playerId === playerId) {
          status = `${esc(seatInfo.username)} <span class="seat-you-badge">(you)</span>`
        } else {
          status = esc(seatInfo.username)
        }
      }
      const crownHtml = state.hostSeat === s ? `<span class="seat-host-crown" title="Host">${CROWN_ICON}</span>` : ''
      return `<div class="${cls}"><span>${crownHtml}${esc(label)}</span><span class="waiting-seat-status">${status}</span></div>`
    }).join('')

    const mySeat = Object.entries(state.seats).find(([, s]) => s?.playerId === playerId)?.[0]
    const changeSeatBtns = mySeat
      ? emptySeats.map((s) => `<button class="btn-secondary btn-sm change-seat-btn" data-seat="${s}">Move to ${s.charAt(0).toUpperCase() + s.slice(1)}</button>`).join('')
      : ''

    const fillBotsBtn = state.isHost && emptySeats.length > 0
      ? `<button class="btn-primary" id="fill-bots-btn">Fill with Bots (${emptySeats.length} seat${emptySeats.length !== 1 ? 's' : ''})</button>`
      : ''

    container.innerHTML = `
      <div class="game-screen">
        <div class="waiting-screen">
          <h2 class="waiting-title">Waiting for players\u2026</h2>
          <div class="waiting-seats">${rows}</div>
          <div class="form-error waiting-err" role="alert" aria-live="polite"></div>
          ${changeSeatBtns}
          ${fillBotsBtn}
          <button class="btn-secondary" id="leave-table-btn">Leave Table</button>
        </div>
      </div>`

    container.querySelectorAll('.change-seat-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const newSeat = btn.dataset.seat
        const errEl = container.querySelector('.waiting-err')
        errEl.textContent = ''
        container.querySelectorAll('.change-seat-btn').forEach((b) => { b.disabled = true })
        btn.textContent = 'Moving\u2026'
        try {
          await apiChangeSeat({ tableId, seat: newSeat, sessionId, playerId })
          state = await getGameState({ tableId, sessionId, playerId })
          render()
        } catch (err) {
          errEl.textContent = err.message || 'Failed to change seat.'
          container.querySelectorAll('.change-seat-btn').forEach((b) => { b.disabled = false })
          btn.textContent = `Move to ${newSeat.charAt(0).toUpperCase() + newSeat.slice(1)}`
        }
      })
    })

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
      if (isMyExchangeTurn) return selectedSet.has(key) ? 'card-sel' : 'card-exch'
      if (isMyPlayTurn && !inputBlocker.isBlocked()) {
        if (state.validCards) {
          const isValid = state.validCards.some((c) => `${c.suit}-${c.rank}` === key)
          return isValid ? 'card-valid' : 'card-invalid'
        }
        return 'card-play'  // fallback when server hasn't sent validCards
      }
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
        ${state.phase === 'playing' || state.phase === 'blind_nil_exchange' ? teamBidTricksHtml(state) : ''}

        <div class="game-table">
          <div class="table-top">
            ${seatInfoHtml(state, rel.across, seatDisplayName(state, rel.across), holdActive && holdTrick?.winner === rel.across)}
          </div>
          <div class="table-middle">
            <div class="table-side table-left">
              ${seatInfoHtml(state, rel.left, seatDisplayName(state, rel.left), holdActive && holdTrick?.winner === rel.left)}
            </div>
            <div class="trick-wrap">
              ${holdActive ? trickHoldHtml(holdTrick, rel) : trickHtml(state, rel)}
              ${!holdActive && state.phase === 'playing' && state.completedTricks.length > 0
                ? '<button class="last-trick-btn" id="last-trick-btn">Last Trick</button>'
                : ''}
            </div>
            <div class="table-side table-right">
              ${seatInfoHtml(state, rel.right, seatDisplayName(state, rel.right), holdActive && holdTrick?.winner === rel.right)}
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

        <div class="game-controls">
          ${leaveGameButtonHtml()}
        </div>
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

    // Leave game button (all players, in-game)
    container.querySelector('#leave-game-btn')?.addEventListener('click', async () => {
      if (!confirm('Leave the game? A bot will take your place until the game ends.')) return
      const btn = container.querySelector('#leave-game-btn')
      btn.disabled = true
      btn.textContent = 'Leaving\u2026'
      try {
        await apiLeaveTable({ tableId, sessionId, playerId })
        cleanup()
        navigate('#/lobby')
      } catch (err) {
        btn.disabled = false
        btn.textContent = 'Leave Game'
        console.log('Leave game failed:', { error: err.message })
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
            // Silently block clicks on cards that are not legal plays
            if (state.validCards) {
              const isValid = state.validCards.some((c) => c.suit === card.suit && c.rank === card.rank)
              if (!isValid) return
            }
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
      onReconnect: async () => {
        console.log('GameSocket reconnected — re-hydrating state:', { tableId })
        try {
          const s = await getGameState({ tableId, sessionId, playerId })
          if (!mounted) return
          state = s
          render()
        } catch (err) {
          console.log('GameSocket rehydration failed:', { tableId, error: err?.message })
        }
      },
      onEvent: async (msg) => {
        console.log('GameSocket event:', { type: msg.type, tableId })
        if (!mounted || acting) return

        // ── Delta events: apply payload directly to state ──────────────────────
        if (DELTA_EVENTS.has(msg.type)) {
          const newState = applyDelta(state, msg, playerId)

          if (msg.type === 'TRICK_COMPLETE') {
            // Trigger the hold so all players see the completed trick before clearing it.
            const trick = { winner: msg.payload.winnerSeat, plays: msg.payload.plays }
            state = newState
            startHold(trick)  // startHold calls render() internally
          } else {
            state = newState
            if (!holdActive) render()
          }
          return
        }

        // ── Full-refresh events: fetch complete server state ────────────────────
        if (!FULL_REFRESH_EVENTS.has(msg.type)) return
        try {
          const s = await getGameState({ tableId, sessionId, playerId })
          if (!mounted) return
          if (holdActive) {
            // Queue the update — apply it after the hold window expires.
            // This covers HAND_SCORED arriving during the trick hold on the 13th trick.
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
