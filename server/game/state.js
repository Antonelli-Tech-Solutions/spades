import { v4 as uuidv4 } from 'uuid'
import { createDeck, shuffle, deal, sortHand, cardEquals } from './deck.js'
import {
  getBiddingOrder,
  isEligibleForBlindNil,
  teamHasBlindNil,
  isValidBidValue,
  computeTeamBids,
  getPartnerSeat,
} from './bid.js'
import { getLegalPlays, determineTrickWinner, isCardLegal } from './trick.js'
import { scoreHand, applyBagPenalties, checkWinLoss } from './score.js'
import { isBot, getBotPlayerId, botBid, botPlay, botBlindNilExchange } from './bot.js'

/** Seats in clockwise order starting from north. */
export const CLOCKWISE_SEATS = ['north', 'east', 'south', 'west']

/**
 * Get the next seat clockwise.
 * @param {string} seat
 * @returns {string}
 */
function nextSeat(seat) {
  return CLOCKWISE_SEATS[(CLOCKWISE_SEATS.indexOf(seat) + 1) % 4]
}

/**
 * Deal and initialise the per-hand state.
 * @param {string} dealerSeat
 * @returns {object} Partial hand state
 */
function dealHand(dealerSeat) {
  const deck = shuffle(createDeck())
  const rawHands = deal(deck)
  const hands = {}
  for (const seat of CLOCKWISE_SEATS) {
    hands[seat] = sortHand(rawHands[seat])
  }
  const biddingOrder = getBiddingOrder(dealerSeat)
  return {
    hands,
    bids: { north: null, east: null, south: null, west: null },
    teamBids: { ns: null, ew: null },
    biddingOrder,
    currentBidderSeat: biddingOrder[0],
    blindNilExchange: null,
    handRevealedSeats: [],
    currentTrick: [],
    completedTricks: [],
    tricksWon: { north: 0, east: 0, south: 0, west: 0 },
    currentPlayerSeat: null, // set when play phase starts
    leadSeat: null, // player left of dealer opens play
    spadesbroken: false,
    isFirstTrick: true,
  }
}

/**
 * Create a new game state.
 *
 * @param {string} tableId
 * @param {{ north: string, east: string, south: string, west: string }} players - Map of seat → playerId
 * @returns {object} Initial game state
 */
export function createGame(tableId, players) {
  const gameId = uuidv4()
  const dealerSeat = 'north' // North deals the first hand
  const handState = dealHand(dealerSeat)

  return {
    gameId,
    tableId,
    handNumber: 1,
    dealerSeat,
    players,
    scores: { ns: 0, ew: 0 },
    bags: { ns: 0, ew: 0 },
    handHistory: [],
    phase: 'bidding',
    gameOver: false,
    winner: null,
    ...handState,
  }
}

/**
 * Validate and apply a bid from the current bidder.
 *
 * @param {object} state
 * @param {string} seat
 * @param {number|'nil'|'blind_nil'} bid
 * @returns {object} New state
 * @throws {Error} If the bid is invalid
 */
export function placeBid(state, seat, bid) {
  if (state.phase !== 'bidding') {
    throw Object.assign(new Error('Game is not in bidding phase'), { code: 'INVALID_ACTION' })
  }
  if (seat !== state.currentBidderSeat) {
    throw Object.assign(new Error('Not your turn to bid'), { code: 'NOT_YOUR_TURN' })
  }
  if (!isValidBidValue(bid)) {
    throw Object.assign(new Error(`Invalid bid value: ${bid}`), { code: 'INVALID_BID' })
  }

  // Blind nil eligibility checks
  if (bid === 'blind_nil') {
    if (!isEligibleForBlindNil(state.scores, seat)) {
      throw Object.assign(
        new Error('Not eligible for Blind Nil — team must be at least 100 points behind'),
        { code: 'NOT_ELIGIBLE' },
      )
    }
    if (teamHasBlindNil(state.bids, seat)) {
      throw Object.assign(
        new Error('A teammate has already bid Blind Nil this hand'),
        { code: 'ALREADY_BID_BLIND_NIL' },
      )
    }
  }

  const newBids = { ...state.bids, [seat]: bid }
  const allBid = Object.values(newBids).every((b) => b !== null)

  if (!allBid) {
    // Advance to next bidder
    const currentIdx = state.biddingOrder.indexOf(seat)
    const nextBidderSeat = state.biddingOrder[currentIdx + 1]
    return { ...state, bids: newBids, currentBidderSeat: nextBidderSeat }
  }

  // All 4 have bid — compute team bids and transition phase
  const teamBids = computeTeamBids(newBids, state.biddingOrder)

  // Check if blind nil exchange is needed
  const blindNilSeats = CLOCKWISE_SEATS.filter((s) => newBids[s] === 'blind_nil')
  if (blindNilSeats.length > 0) {
    // Blind nil player sends cards first
    const firstBlindNil = blindNilSeats[0]
    return {
      ...state,
      bids: newBids,
      teamBids,
      currentBidderSeat: null,
      phase: 'blind_nil_exchange',
      blindNilExchange: {
        pending: [...blindNilSeats],
        currentBlindNilSeat: firstBlindNil,
        step: 'blind_to_partner',
        cardsFromBlind: null,
      },
    }
  }

  // No blind nil — move straight to playing
  return startPlayPhase({ ...state, bids: newBids, teamBids, currentBidderSeat: null })
}

/**
 * Transition state to the playing phase.
 * Sets currentPlayerSeat and leadSeat to the player left of the dealer.
 */
function startPlayPhase(state) {
  const leadSeat = nextSeat(state.dealerSeat)
  return {
    ...state,
    phase: 'playing',
    currentPlayerSeat: leadSeat,
    leadSeat,
  }
}

/**
 * Handle a blind nil card exchange.
 *
 * Step 1: blind nil player sends 2 cards to partner.
 * Step 2: partner sends 2 cards back to blind nil player.
 *
 * @param {object} state
 * @param {string} seat - Seat submitting the exchange
 * @param {Array<{suit: string, rank: string}>} cards - Exactly 2 cards
 * @returns {object} New state
 */
export function submitBlindNilExchange(state, seat, cards) {
  if (state.phase !== 'blind_nil_exchange') {
    throw Object.assign(new Error('Game is not in blind nil exchange phase'), { code: 'INVALID_ACTION' })
  }
  if (!Array.isArray(cards) || cards.length !== 2) {
    throw Object.assign(new Error('Must submit exactly 2 cards'), { code: 'INVALID_EXCHANGE' })
  }

  const { blindNilExchange } = state
  const { currentBlindNilSeat, step } = blindNilExchange
  const partnerSeat = getPartnerSeat(currentBlindNilSeat)

  if (step === 'blind_to_partner') {
    if (seat !== currentBlindNilSeat) {
      throw Object.assign(
        new Error('Blind Nil player must send cards first'),
        { code: 'INVALID_EXCHANGE' },
      )
    }
    // Verify cards are in blind nil player's hand
    const hand = state.hands[seat]
    for (const card of cards) {
      if (!hand.some((c) => cardEquals(c, card))) {
        throw Object.assign(
          new Error('Card not in hand'),
          { code: 'CARD_NOT_IN_HAND' },
        )
      }
    }
    // Remove cards from blind nil player's hand
    const newHand = hand.filter((c) => !cards.some((card) => cardEquals(c, card)))

    return {
      ...state,
      hands: { ...state.hands, [seat]: sortHand(newHand) },
      blindNilExchange: {
        ...blindNilExchange,
        step: 'partner_to_blind',
        cardsFromBlind: cards,
      },
    }
  }

  // step === 'partner_to_blind'
  if (seat !== partnerSeat) {
    throw Object.assign(
      new Error('Partner must send cards back to Blind Nil player'),
      { code: 'INVALID_EXCHANGE' },
    )
  }
  const partnerHand = state.hands[seat]
  for (const card of cards) {
    if (!partnerHand.some((c) => cardEquals(c, card))) {
      throw Object.assign(new Error('Card not in hand'), { code: 'CARD_NOT_IN_HAND' })
    }
  }

  // Complete the exchange
  const cardsFromBlind = blindNilExchange.cardsFromBlind
  const newPartnerHand = partnerHand.filter((c) => !cards.some((card) => cardEquals(c, card)))
  const newBlindHand = state.hands[currentBlindNilSeat]

  // Give partner the blind nil player's cards; give blind nil player the partner's cards
  const finalPartnerHand = sortHand([...newPartnerHand, ...cardsFromBlind])
  const finalBlindHand = sortHand([...newBlindHand, ...cards])

  const newHands = {
    ...state.hands,
    [currentBlindNilSeat]: finalBlindHand,
    [partnerSeat]: finalPartnerHand,
  }

  // Check if there are more blind nil players to process
  const remainingPending = blindNilExchange.pending.filter((s) => s !== currentBlindNilSeat)

  if (remainingPending.length > 0) {
    const nextBlindNil = remainingPending[0]
    return {
      ...state,
      hands: newHands,
      blindNilExchange: {
        pending: remainingPending,
        currentBlindNilSeat: nextBlindNil,
        step: 'blind_to_partner',
        cardsFromBlind: null,
      },
    }
  }

  // All exchanges done — start play
  return startPlayPhase({
    ...state,
    hands: newHands,
    blindNilExchange: null,
  })
}

/**
 * Play a card from a player's hand.
 *
 * @param {object} state
 * @param {string} seat - Seat playing the card
 * @param {{ suit: string, rank: string }} card
 * @returns {object} New state
 */
export function playCard(state, seat, card) {
  if (state.phase !== 'playing') {
    throw Object.assign(new Error('Game is not in playing phase'), { code: 'INVALID_ACTION' })
  }
  if (seat !== state.currentPlayerSeat) {
    throw Object.assign(new Error('Not your turn to play'), { code: 'NOT_YOUR_TURN' })
  }

  const hand = state.hands[seat]
  if (!hand.some((c) => cardEquals(c, card))) {
    throw Object.assign(new Error('Card not in hand — invalid card'), { code: 'CARD_NOT_IN_HAND' })
  }
  if (!isCardLegal(card, hand, state.currentTrick, state.spadesbroken, state.isFirstTrick)) {
    throw Object.assign(new Error('Illegal play'), { code: 'ILLEGAL_PLAY' })
  }

  // Remove card from hand
  const newHand = hand.filter((c) => !cardEquals(c, card))
  const newTrick = [...state.currentTrick, { seat, card }]

  // Track spades breaking — PRD §5.1: "Spades are broken by the first Spade played
  // (after the first trick)". A spade played on trick 1 (only legal when a player
  // holds nothing but spades) does not break spades.
  let { spadesbroken } = state
  if (card.suit === 'spades' && !spadesbroken && !state.isFirstTrick) {
    spadesbroken = true
    console.log('Spades broken:', { tableId: state.tableId, seat, card })
  }

  if (newTrick.length < 4) {
    // Trick not yet complete — advance to next player
    return {
      ...state,
      hands: { ...state.hands, [seat]: newHand },
      currentTrick: newTrick,
      currentPlayerSeat: nextSeat(seat),
      spadesbroken,
    }
  }

  // Trick complete — determine winner
  const trickWinner = determineTrickWinner(newTrick)
  const newTricksWon = {
    ...state.tricksWon,
    [trickWinner]: state.tricksWon[trickWinner] + 1,
  }
  const completedTricks = [
    ...state.completedTricks,
    { winner: trickWinner, plays: newTrick },
  ]

  console.log('Trick complete:', {
    tableId: state.tableId,
    trickNumber: completedTricks.length,
    winner: trickWinner,
  })

  const newHands = { ...state.hands, [seat]: newHand }

  if (completedTricks.length < 13) {
    // More tricks to play
    return {
      ...state,
      hands: newHands,
      currentTrick: [],
      completedTricks,
      tricksWon: newTricksWon,
      currentPlayerSeat: trickWinner,
      leadSeat: trickWinner,
      spadesbroken,
      isFirstTrick: false,
    }
  }

  // All 13 tricks played — score the hand
  return scoreCompletedHand({
    ...state,
    hands: newHands,
    currentTrick: [],
    completedTricks,
    tricksWon: newTricksWon,
    currentPlayerSeat: null,
    spadesbroken,
    isFirstTrick: false,
  })
}

/**
 * Score a completed hand and transition to the next hand or end the game.
 * Appends a summary entry to state.handHistory before transitioning.
 */
function scoreCompletedHand(state) {
  const { scoreDelta, newBags } = scoreHand({
    bids: state.bids,
    teamBids: state.teamBids,
    tricksWon: state.tricksWon,
  })

  const rawScores = {
    ns: state.scores.ns + scoreDelta.ns,
    ew: state.scores.ew + scoreDelta.ew,
  }

  // Count how many 10-bag penalties each team crosses this hand
  const bagPenalty = {
    ns: Math.floor((state.bags.ns + newBags.ns) / 10),
    ew: Math.floor((state.bags.ew + newBags.ew) / 10),
  }

  const { scores, bags } = applyBagPenalties(rawScores, state.bags, newBags)

  console.log('Hand scored:', {
    tableId: state.tableId,
    handNumber: state.handNumber,
    scoreDelta,
    newBags,
    bagPenalty,
    scores,
    bags,
  })

  // Build the hand history entry for this completed hand
  const handEntry = {
    handNumber: state.handNumber,
    bids: { ...state.bids },
    teamBids: { ...state.teamBids },
    tricksWon: { ...state.tricksWon },
    scoreDelta,
    newBags,
    bagPenalty,
    scoresBefore: { ...state.scores },
    bagsBefore: { ...state.bags },
    scoresAfter: { ...scores },
    bagsAfter: { ...bags },
  }
  const handHistory = [...(state.handHistory || []), handEntry]

  const winLoss = checkWinLoss(scores)
  if (winLoss) {
    console.log('Game over:', { tableId: state.tableId, winner: winLoss.winner })
    return {
      ...state,
      scores,
      bags,
      handHistory,
      phase: 'game_over',
      gameOver: true,
      winner: winLoss.winner,
    }
  }

  // Start the next hand
  const nextDealer = nextSeat(state.dealerSeat)
  const nextHandState = dealHand(nextDealer)

  console.log('Starting next hand:', {
    tableId: state.tableId,
    handNumber: state.handNumber + 1,
    dealer: nextDealer,
  })

  return {
    ...state,
    ...nextHandState,
    handNumber: state.handNumber + 1,
    dealerSeat: nextDealer,
    scores,
    bags,
    handHistory,
    phase: 'bidding',
    gameOver: false,
    winner: null,
  }
}

/**
 * Reveal the hand for a Blind Nil eligible player before they have bid.
 * After calling this, getPlayerView will include myHand for this player.
 *
 * @param {object} state
 * @param {string} seat
 * @returns {object} New state
 * @throws {Error} If ineligible, already bid, or wrong phase
 */
export function revealHand(state, seat) {
  if (state.phase !== 'bidding') {
    throw Object.assign(new Error('Game is not in bidding phase'), { code: 'INVALID_ACTION' })
  }
  if (!isEligibleForBlindNil(state.scores, seat)) {
    throw Object.assign(new Error('Not eligible for Blind Nil'), { code: 'NOT_ELIGIBLE' })
  }
  if (state.bids[seat] !== null) {
    throw Object.assign(new Error('Cannot reveal hand after placing a bid'), { code: 'BID_ALREADY_PLACED' })
  }
  return {
    ...state,
    handRevealedSeats: [...(state.handRevealedSeats || []), seat],
  }
}

/**
 * Return a player-specific view of the game state that does not expose other
 * players' hands. This is what gets sent to the client.
 *
 * For Blind Nil eligible players who have not yet revealed their hand,
 * myHand is omitted and blindNilEligible is set to true.
 *
 * @param {object} state - Full server game state
 * @param {string} seat - The requesting player's seat
 * @returns {object} Filtered state safe to send to the client
 */
export function getPlayerView(state, seat) {
  const { hands, ...rest } = state
  const isEligible = isEligibleForBlindNil(state.scores, seat)
  const hasRevealed = (state.handRevealedSeats || []).includes(seat)

  // Withhold hand from eligible players who have not yet revealed during bidding
  if (state.phase === 'bidding' && isEligible && !hasRevealed) {
    return {
      ...rest,
      blindNilEligible: true,
      // myHand intentionally omitted until player calls reveal-hand or bids Blind Nil
    }
  }

  return {
    ...rest,
    blindNilEligible: false,
    myHand: hands[seat],
    // Include played cards from the current trick (visible to all)
    // Do NOT include other players' unplayed hands
  }
}

/**
 * Automatically advance the game state through any consecutive bot turns.
 * Loops until it is a human player's turn or the game is over.
 *
 * @param {object} state - Current game state
 * @returns {object} Updated game state after all bot actions are applied
 */
export function advanceBotTurns(state) {
  let current = state
  while (true) {
    if (current.phase === 'bidding') {
      const seat = current.currentBidderSeat
      if (!seat || !isBot(current.players[seat])) break
      const partnerSeat = getPartnerSeat(seat)
      const partnerBid = current.bids[partnerSeat]
      const bid = botBid(current.hands[seat], partnerBid)
      console.log('Bot bid:', { seat, bid, tableId: current.tableId })
      current = placeBid(current, seat, bid)
    } else if (current.phase === 'playing') {
      const seat = current.currentPlayerSeat
      if (!seat || !isBot(current.players[seat])) break
      const card = botPlay(current.hands[seat], current.currentTrick, current.spadesbroken, current.isFirstTrick)
      console.log('Bot play:', { seat, card, tableId: current.tableId })
      current = playCard(current, seat, card)
    } else if (current.phase === 'blind_nil_exchange') {
      const { currentBlindNilSeat, step } = current.blindNilExchange
      // Bots never bid blind nil, so they can only act as the partner (step: partner_to_blind)
      if (step !== 'partner_to_blind') break
      const partnerSeat = getPartnerSeat(currentBlindNilSeat)
      if (!isBot(current.players[partnerSeat])) break
      const cards = botBlindNilExchange(current.hands[partnerSeat])
      console.log('Bot blind nil exchange:', { seat: partnerSeat, cards, tableId: current.tableId })
      current = submitBlindNilExchange(current, partnerSeat, cards)
    } else {
      // game_over — nothing to auto-advance
      break
    }
  }
  return current
}

/**
 * Replace a human player at the given seat with a bot and advance any bot turns.
 * Called when a human leaves an in-progress game.
 *
 * @param {object} gameState - Current game state
 * @param {string} seat - The seat being vacated
 * @returns {object} Updated game state with the bot seated and all immediate bot turns applied
 */
export function substitutePlayerWithBot(gameState, seat) {
  const botId = getBotPlayerId(seat)
  const withBot = { ...gameState, players: { ...gameState.players, [seat]: botId } }
  return advanceBotTurns(withBot)
}
