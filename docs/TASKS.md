# Spades Online — Task List

> Generated from `docs/spades_prd.md`. All decisions and acceptance criteria live in the PRD — consult it before implementing any task.
> Priority: **P0** = critical for launch · **P1** = important · **P2** = nice to have · **OQ** = blocked on open question

---

## Dependency Order

Complete P0 tasks in this order. Tasks within the same group are independent and can be parallelised.

**Group 1 — Foundation (no dependencies)**
- Authentication & Accounts (all tasks)
- Core Gameplay (all tasks)

**Group 2 — Requires Group 1**
- Lobby & Table Management — requires auth (players must be authenticated to create/join tables)
- Spectating — requires the arrive-then-sit flow from Lobby & Table Management

**Group 3 — Requires Group 2**
- Social Features — friends list table links require lobby and presence to be functional
- Performance & Infrastructure — load and latency targets can only be validated once game loop and lobby are complete

**Group 4 — Requires Group 3**
- UI & Customization — can be layered on top of a working game

**No dependencies (can be done at any time)**
- Open Questions — these are decisions, not implementation tasks

---

## Authentication & Accounts

- [x] `P0` Implement email/password registration with required email verification
- [x] `P0` Implement login and session management
- [ ] `P0` Apply rate limiting on all authentication endpoints
- [ ] `P1` Add optional 2FA via authenticator app
- [x] `P1` Build player profile page (username, avatar, career win/loss record, recent 20 games, cosmetics)

---

## Lobby & Table Management

- [ ] `P0` Build public lobby browser showing table name, host, seat count, ruleset, and join policy (Open / Friends-Only / Invite-Only)
- [ ] `P0` Implement table creation with: name, visibility (Public / Friends-Only / Private), join policy (filtered by visibility), and spectating toggle
- [ ] `P0` Enforce join policy constraint: join policy cannot be less restrictive than visibility; hide join policy control for Private tables
- [ ] `P0` Implement host controls: seat assignment, kick player, transfer host
- [ ] `P0` Build shareable join link: bypasses both visibility and join policy; grants seating rights
- [ ] `P0` Build shareable spectator link: bypasses visibility only; grants observe access but not seating rights
- [ ] `P0` Implement arrive-then-sit flow: arriving at a table puts player in observer state; sitting is a separate action governed by join policy
- [ ] `P0` Gate game start until all 4 human seats are filled
- [ ] `P0` Implement seating UI: North/South vs East/West fixed partnerships, manual or player-choice seating
- [ ] `P1` Implement direct in-app invite via friends list and username search: bypasses visibility and join policy
- [ ] `P1` Deliver in-app invite notifications with one-click join; notify host on decline
- [ ] `P1` Add lobby filtering by seats available and table name search

---

## Spectating

- [ ] `P0` Implement observe-only spectator state: spectators can see the game but cannot interact or influence play
- [ ] `P0` Allow any player who can see a table (via lobby, friends list, join link, or spectator link) to spectate, subject to the host's spectating setting
- [ ] `P1` Display spectators in a separate observer rail, distinct from seated players

---

## Core Gameplay

- [ ] `P0` Implement full Spades game loop: deal, bid, play tricks, score, repeat
- [ ] `P0` Implement dealer rotation: North deals first hand, button rotates clockwise each hand
- [ ] `P0` Implement partnership bidding: first bidder bids individually, second bidder sets team total (first bidder's number is advisory only)
- [ ] `P0` Implement Nil bid (+50 / -50)
- [ ] `P0` Implement Blind Nil bid (+100 / -100): eligibility check (≥100 pts behind), one-per-team limit, card exchange after all bids but before opening lead
- [ ] `P0` Implement team bid of 0: legal, not treated as Nil; every trick taken is a bag
- [ ] `P0` Enforce no Spade lead on first trick rule
- [ ] `P0` Implement Spades-breaking logic
- [ ] `P0` Implement bag tracking: +1 per overtrick; -100 pts per 10 bags; nil bidder tricks count toward partner's bid and are bags if partner exceeds their bid; double-nil — every trick either player takes is a bag and breaks that individual's nil
- [ ] `P0` Implement win condition: first to 250 pts wins; if both reach 250 in same round, higher score wins; exact tie plays another hand
- [ ] `P0` Implement loss condition: -250 or lower is immediate loss; if both teams qualify, higher score wins; exact tie plays another hand
- [ ] `P0` Server-side game state validation: legal move enforcement, no out-of-turn plays, no cards not in hand
- [ ] `P0` Ensure no opponent card info is sent to client before it is played

---

## Social Features

- [ ] `P1` Build friends list: send, accept, decline requests by username search
- [ ] `P1` Show online / offline / in-game status; display table name if player has visibility permission, "Playing at a private table" if not, "In lobby" if between games
- [ ] `P1` Allow going to a friend's table from the friends list, subject to visibility and join policy
- [ ] `P1` Implement block: prevent friend requests and game invitations from blocked players
- [ ] `P1` Deliver friend request notifications in-app and via push (if enabled)
- [ ] `P1` Build in-game chat panel with profanity filter; allow host to disable
- [ ] `P2` Implement chat abuse reporting (moderation policy unresolved — see OQ-6; do not implement mute mechanics until decided)

---

## UI & Customization

- [ ] `P0` Always sort hand by suit and rank (not configurable)
- [ ] `P1` Build hand display in Spread (fan) and Hand Diagram modes
- [ ] `P1` Implement gameplay settings: confirm-play toggle, animation speed, previous trick viewer
- [ ] `P2` Implement 4 table felt colors, 3 card back designs, 8 default avatar icons
- [ ] `P2` Build audio settings: master/music/SFX volume sliders, per-sound toggles, music track selection
- [ ] `P2` Add push notification preferences for friend activity and game invitations

---

## Performance & Infrastructure

- [ ] `P0` Achieve <200ms p95 turn action latency (card play → all clients updated)
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
- `v1.1` Standard bot + disconnect fill
- `v1.2` Solo ranked queue + MMR system
- `v1.2` Duo ranked queue
- `v1.3` Premium cosmetics & billing
- `v1.3` Ruleset customization
- `v1.3` Profile privacy, badge & extended history
- `v1.3` Subscription gifting
- `v2.0` Game variants (Cutthroat, Suicide, Whiz, Mirrors)
