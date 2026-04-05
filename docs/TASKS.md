# Spades Online — Task List

> Generated from `docs/spades_prd.md`. All decisions and acceptance criteria live in the PRD — consult it before implementing any task.
> Priority: **P0** = critical for launch · **P1** = important · **P2** = nice to have · **OQ** = blocked on open question
>
> Tasks are organised as **vertical slices** — each slice delivers a complete, testable, end-to-end increment. Do not start a slice until all P0 tasks in the previous slice are complete and merged to `dev`.

---

## ✅ Completed

- [x] `BUG` Fix play/bid order appearing counterclockwise in the web UI: `relSeats()` in `client/web/src/screens/game.js` had `left` and `right` swapped, making each player's clockwise neighbour appear on the wrong side of the screen. Extracted `relSeats` and `CW` to `client/web/src/seatUtils.js` and added unit tests. Server engine was unaffected.

- [x] `DEV` `DEV_AUTO_VERIFY` env var — when set to `true`, registration skips email verification and marks the player as verified immediately. Enables registering multiple test accounts without an email server. Never set in production.
- [x] `DEV` Simple bot players — `POST /api/tables/:tableId/add-bot` lets the table host add a bot to any empty seat. Bots bid the number of spades in their hand and play a random legal card. Bot turns advance automatically server-side after each human action; no client round-trips needed. Bot IDs follow the pattern `bot:<seat>` and are scoped to dev/test use — they do not affect the production bot design in v1.1.
- [x] `DEV` Bot blind nil card exchange — when a human bids blind nil and their partner is a bot, the bot automatically passes 2 random cards during the `partner_to_blind` exchange step, allowing games with bot partners to proceed through the blind nil exchange without stalling.
- [x] `P0` Implement email/password registration with required email verification
- [x] `P0` Resend verification email flow: `POST /api/auth/resend-verification` + UI prompt on login 403 and registration success screen
- [x] `P0` Forgot password flow: `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`, forgot/reset password screens with proper success/error landing pages
- [x] `P0` Implement login and session management
- [x] `P0` Apply rate limiting on all authentication endpoints
- [x] `P1` Build player profile page (username, avatar, career win/loss record, recent 20 games, cosmetics)
- [x] `P1` Add logout button to the lobby screen (`client/web/src/screens/lobby.js`): calls `POST /api/auth/logout`, clears `sessionStorage`, and redirects to the login screen
- [x] `DEV` Host terminate game — `POST /api/tables/:tableId/terminate` lets the table host immediately end a game at any point (waiting or in progress). Deletes the table and game state from Redis. All seated players are redirected to the lobby on their next poll (404 from state endpoint). A "Terminate Game" button with a browser confirm prompt is shown to the host on both the waiting screen and during active play (`server/lobby/table.js`, `server/server.js`, `client/web/src/api.js`, `client/web/src/screens/game.js`).
- [x] `P1` Leave table — `POST /api/tables/:tableId/leave` removes the requesting player from their seat. If the table is 'waiting', the seat is vacated. If a game is in progress, the vacated seat is immediately filled by a bot (`bot:<seat>`) and the game continues uninterrupted (see PRD Section 6.4.7). A "Leave Table" button on the waiting screen calls this endpoint and redirects the player to the lobby on success (`server/lobby/table.js`, `server/server.js`, `client/web/src/api.js`, `client/web/src/screens/game.js`).

---

## Slice 1 — One Complete Playable Game

> Goal: two teams of two can create a table, sit down, play a full game of Spades to completion, and see the result — entirely through the web UI. This slice is the foundation everything else builds on. Do not move to Slice 2 until a complete game can be played end-to-end.

### Backend

- [x] `P0` Implement full Spades game loop: deal, bid, play tricks, score, repeat
- [x] `P0` Implement dealer rotation: North deals first hand, button rotates clockwise each hand
- [x] `P0` Implement partnership bidding: first bidder bids individually, second bidder sets team total (first bidder's number is advisory only)
- [x] `P0` Implement Nil bid (+50 / -50)
- [x] `P0` Implement Blind Nil bid (+100 / -100): eligibility check (≥100 pts behind), one-per-team limit, card exchange after all bids but before opening lead
- [x] `P0` Blind Nil hand hiding — server-side enforcement: when a team is eligible for Blind Nil at deal time, omit `myHand` from `HAND_DEALT` for those players and set `blindNilEligible: true`; add `POST /api/tables/:tableId/reveal-hand` that validates bidding phase, player eligibility, and no bid yet placed — then emits `HAND_REVEALED` with `myHand` to that player only; bidding Blind Nil also triggers the hand reveal to the server's game state as normal
- [x] `P0` Implement team bid of 0: legal, not treated as Nil; every trick taken is a bag
- [x] `P0` Enforce no Spade lead on first trick rule
- [x] `P0` Implement Spades-breaking logic
- [x] `P0` Implement bag tracking: +1 per overtrick; -100 pts per 10 bags; nil bidder tricks count toward partner's bid and are bags if partner exceeds their bid; double-nil — every trick either player takes is a bag and breaks that individual's nil
- [x] `P0` Implement win condition: first to 250 pts wins; if both reach 250 in same round, higher score wins; exact tie plays another hand
- [x] `P0` Implement loss condition: -250 or lower is immediate loss; if both teams qualify, higher score wins; exact tie plays another hand
- [x] `P0` Server-side game state validation: legal move enforcement, no out-of-turn plays, no cards not in hand
- [x] `P0` Ensure no opponent card info is sent to client before it is played
- [x] `P0` Basic table creation: create a table, seat 4 players (North/South vs East/West), start game when full
- [x] `P0` Gate game start until all 4 human seats are filled
- [x] `P0` Always sort hand by suit and rank (not configurable)

### Web UI (minimal — enough to play)

- [x] `P0` Registration and login screens
- [x] `P0` Create table screen: name only (no visibility/join policy yet)
- [x] `P0` Join table screen: list of open tables, click to join and choose a seat
- [x] `P0` Game screen: display hand, bid input, card play, current trick, scoreboard
- [ ] `P0` Bidding UI — partnership clarity: label the second bidder's input as "Team Total", show the partner's bid adjacent to the input, display a live individual-contribution hint that switches to a bag warning (e.g. *"⚠ Team target (2) is below partner's bid (4) — every trick above 2 is a bag"*) when the team total falls below the partner's bid, and show the team's combined bid in the post-bid summary (see PRD Section 5.3)
- [x] `P0` Blind Nil hand hiding — web UI: when `HAND_DEALT` arrives with `blindNilEligible: true` and no `myHand`, render face-down card backs in the hand area and show "Reveal Hand" and "Bid Blind Nil" action buttons in place of the normal bid input; on "Reveal Hand", call `POST /api/tables/:tableId/reveal-hand` and display cards when `HAND_REVEALED` arrives; on "Bid Blind Nil", submit the bid directly — the hand is never displayed to the player
- [x] `P0` Build hand display in Spread (fan) and Hand Diagram modes
- [x] `P0` Game over screen: show final score and winner — unified with final hand summary overlay; `gameOver.js` removed; `endOfHandSummaryHtml` accepts optional `gameOverInfo` param to display winner announcement and "Back to Lobby" button in place of "Continue" (issue #178)
- [x] `P1` Auto-return to table: if a seated player navigates away (lobby, create-table, join) or revisits after a session refresh, they are automatically redirected back to their active table. Implemented via `GET /api/player/table` (returns player's active non-finished tableId) and a `redirectIfSeated` client utility called on each non-table screen mount. `currentTableId` stored in sessionStorage for instant fast-path redirect on page reload; cleared by the game screen `cleanup()` and on logout (issue #197)
- [x] `P1` End-of-trick hold: when the fourth card of a trick is played, keep the completed trick visible for 1500 ms (normal speed, hardcoded until the animation speed setting ships in Slice 5), highlight the winning seat, then clear — state updates that arrive during the hold window are queued and applied only after the hold expires; hold applies to the 13th trick too — `lastTrick` is stored in the hand history entry so the client can trigger the hold even when `completedTricks` has been reset for the new hand (issue #212)
- [ ] `P1` Input blocking: disable card play input for the active player from when they play a card until the card play animation (Slice 2) and end-of-trick hold have both fully completed — a `TURN_CHANGED` event arriving during this window must not re-enable input early

### Testing

- [x] `P0` End-to-end test: 4 players complete a full game from table creation to game over
- [x] `P0` Unit tests: blind nil eligible player does not receive `myHand` in `HAND_DEALT`; `HAND_REVEALED` is emitted only after `reveal-hand` is called; `reveal-hand` is rejected if the player has already placed a bid or is not eligible; ineligible team receives their full hand immediately
- [x] `P0` Integration test: blind nil eligible player's hand is withheld until reveal; both reveal-then-bid and bid-blind-nil-directly flows complete successfully

---

## Slice 2 — Real-Time WebSocket Layer

> Goal: all in-game state updates are delivered via WebSocket push instead of HTTP polling. This slice is a prerequisite for Slice 3 (spectating requires live updates) and Slice 4 (social presence requires connection state). Do not start Slice 3 until this slice is complete and merged to `dev`.
>
> See `docs/spades_prd.md` Section 6.4 for the full real-time architecture spec, event catalog, and disconnect/reconnect behaviour.

### Backend

- [x] `P0` Build `server/ws/` WebSocket server: authenticated connection upgrade (`x-session-id` header), table room management (`table:{tableId}` rooms), heartbeat ping/pong (30 s interval, 10 s timeout)
- [x] `BUG` Security: WebSocket JOIN handler now verifies the player is seated at the requested table before subscribing them to the room. Unauthorised JOIN attempts receive a `JOIN_DENIED` event instead of being silently admitted, closing the card-visibility information-leak.
- [x] `P0` Implement Redis pub/sub fan-out: each `table:{tableId}` room and the `lobby` channel map to a Redis pub/sub channel so all server instances can broadcast to connected clients
- [x] `P0` Emit in-game events after each validated state mutation: `HAND_DEALT` (per-player), `BID_PLACED`, `BLIND_NIL_EXCHANGE_PROMPT`, `CARD_PLAYED`, `TRICK_COMPLETE`, `HAND_SCORED`, `GAME_OVER`, `TURN_CHANGED`
- [ ] `P0` Implement player disconnect detection: emit `PLAYER_DISCONNECTED` with a 60 s reconnect window on ping failure or clean close; emit `PLAYER_RECONNECTED` when the player re-joins within the window; stall game with "waiting for reconnect" indicator if window expires
- [ ] `P1` Emit lobby events to the `lobby` channel for **Public tables only**: `TABLE_CREATED`, `TABLE_UPDATED`, `TABLE_REMOVED` — visibility-aware routing (Friends-Only → `player:{id}:notify`, transitions on visibility change, friend-list side effects) is implemented in Slice 3 alongside the full visibility model

### Web Client

- [ ] `P0` Establish authenticated WSS connection on game screen mount; tear down on unmount
- [ ] `P0` Remove `schedulePoll()` timeout loop from `client/web/src/screens/game.js`; re-render on incoming WebSocket events instead
- [ ] `P0` On reconnect: call `GET /api/tables/:tableId/state` to re-hydrate, then resume WS event listener
- [ ] `P1` Subscribe to lobby channel on lobby screen mount; update table list on `TABLE_CREATED`, `TABLE_UPDATED`, `TABLE_REMOVED` — eliminating the manual-refresh requirement for Public tables (Friends-Only table events arrive on the personal notification channel added in Slice 3)

### Testing

- [ ] `P0` Unit tests (`test/ws/`): connection authentication, room join/leave, event emission after each game action, ping/pong lifecycle
- [ ] `P0` Integration test: play a card action triggers `CARD_PLAYED` event received by all players in the room
- [ ] `P0` Integration test: disconnect within reconnect window resumes game; expired window stalls game
- [ ] `P1` Integration test: `TABLE_CREATED` / `TABLE_UPDATED` / `TABLE_REMOVED` events delivered to lobby channel subscribers

---

## Slice 3 — Full Lobby & Access Control

> Goal: the complete table discovery and access model from the PRD is in place — public/friends-only/private visibility, join policies, shareable links, spectating, and the arrive-then-sit flow.

- [ ] `P0` Subscribe each connected client to their personal notification channel `player:{playerId}:notify` on WebSocket connect; this channel delivers Friends-Only table events and Slice 4 social notifications (friend requests, in-app invites)
- [ ] `P0` Implement visibility-aware lobby event routing: Public tables → `lobby` channel; Friends-Only tables → `player:{friendId}:notify` per friend of host; Private tables → no broadcast (see PRD Section 6.4.4)
- [ ] `P0` Implement visibility transition events: when a host changes table visibility, send `TABLE_REMOVED` on the old audience's channel and `TABLE_CREATED` on the new audience's channel (all six transition combinations in PRD Section 6.4.4)
- [ ] `P0` Implement friend-list side effects for Friends-Only tables: on host-removes-friend emit `TABLE_REMOVED` to that player's notify channel; on host-accepts-friend-request emit `TABLE_CREATED` (current state) to new friend's notify channel
- [ ] `P0` Add `visibility` field to `TABLE_CREATED` and `TABLE_UPDATED` payloads
- [ ] `P1` Integration tests: Friends-Only table events reach only host's friends; visibility transition correctly removes from old audience and adds to new; friend-list change side effects fire correctly
- [ ] `P0` Implement full table creation config: visibility (Public / Friends-Only / Private), join policy (filtered by visibility), spectating toggle
- [ ] `P0` Enforce join policy constraint: join policy cannot be less restrictive than visibility; hide join policy control for Private tables
- [ ] `P0` Build public lobby browser showing table name, host, seat count, ruleset, and join policy
- [ ] `P0` Add lobby filtering by seats available and table name search
- [ ] `P0` Implement arrive-then-sit flow: arriving at a table puts player in observer state; sitting is a separate action governed by join policy
- [ ] `P0` Implement host controls: seat assignment, kick player, transfer host
- [ ] `P0` Build shareable join link: bypasses both visibility and join policy; grants seating rights
- [ ] `P0` Build shareable spectator link: bypasses visibility only; grants observe access but not seating rights
- [ ] `P0` Implement observe-only spectator state: spectators can see the game but cannot interact or influence play
- [ ] `P0` Allow any player who can see a table to spectate, subject to the host's spectating setting
- [ ] `P1` Display spectators in a separate observer rail, distinct from seated players

---

## Slice 4 — Social Features

> Goal: players can find and play with friends, see who is online, and communicate during games.

- [ ] `P1` Build friends list: send, accept, decline requests by username search
- [ ] `P1` Show online / offline / in-game status; display table name if player has visibility permission, "Playing at a private table" if not, "In lobby" if between games
- [ ] `P1` Allow going to a friend's table from the friends list, subject to visibility and join policy
- [ ] `P1` Implement direct in-app invite via friends list and username search: bypasses visibility and join policy
- [ ] `P1` Deliver in-app invite notifications with one-click join; notify host on decline
- [ ] `P1` Implement block: prevent friend requests and game invitations from blocked players
- [ ] `P1` Deliver friend request notifications in-app and via push (if enabled)
- [ ] `P1` Build in-game chat panel with profanity filter; allow host to disable
- [ ] `P2` Implement chat abuse reporting (moderation policy unresolved — see OQ-6; do not implement mute mechanics until decided)

---

## Slice 5 — UI Polish & Customization

> Goal: the game looks and feels good; players can personalise their experience.

- [ ] `P1` Add optional 2FA via authenticator app
- [ ] `P1` Implement gameplay settings: confirm-play toggle, animation speed, previous trick viewer
- [ ] `P2` Implement 4 table felt colors, 3 card back designs, 8 default avatar icons
- [ ] `P2` Build audio settings: master/music/SFX volume sliders, per-sound toggles, music track selection
- [ ] `P2` Add push notification preferences for friend activity and game invitations

---

## Slice 6 — Scale, Harden & Mobile

> Goal: the game meets its non-functional requirements and is available on mobile. The <200ms p95 latency target is achieved by the WebSocket implementation in Slice 2; this slice validates it at scale.

- [ ] `P0` Load test and validate <200ms p95 turn action latency (card play → all clients updated) at 10,000+ concurrent sessions
- [ ] `P0` Support 10,000+ concurrent game sessions at launch
- [ ] `P0` Maintain 99.5% monthly uptime SLA
- [ ] `P0` Build responsive web app for Chrome 100+, Firefox 100+, Safari 15+, Edge 100+ (desktop & tablet)
- [ ] `P0` Build native mobile apps for iOS 15+ and Android 10+ via React Native or Flutter
- [ ] `P1` Achieve <3s cold start on mid-range mobile devices

---

## Open Questions — Blocked, Do Not Implement

> These items must not be built until the decision is recorded in `docs/spades_prd.md`.

- [ ] `OQ` OQ-1: Premium pricing model — subscription vs. one-time cosmetic packs vs. both (needed before v1.3)
- [ ] `OQ` OQ-2: Individual bidding mode alongside partnership bidding (needed before v1.3)
- [ ] `OQ` OQ-3: Fixed vs. configurable score target for ranked games (needed before v1.2)
- [ ] `OQ` OQ-4: Shared vs. separate MMR for Solo Queue and Duo Queue (needed before v1.2)
- [ ] `OQ` OQ-6: Chat moderation policy — abuse definition, review process, mute mechanics (needed before launch)

---

## Post-Launch — Out of Scope for v1.0

> Do not implement. Scope defined in `docs/spades_prd.md` Section 9.

- `v1.1` Spectator chat settings (no chat / separate channel / shared)
- `v1.1` Standard bot + disconnect fill (voluntary-leave bot-fill is already in v1.0 — see PRD Section 6.4.7; this covers network-disconnect fill and full casual-bot experience)
- `v1.2` Solo ranked queue + MMR system
- `v1.2` Duo ranked queue
- `v1.3` Premium cosmetics & billing
- `v1.3` Ruleset customization
- `v1.3` Profile privacy, badge & extended history
- `v1.3` Subscription gifting
- `v2.0` Game variants (Cutthroat, Suicide, Whiz, Mirrors)
