# Spades Online — Claude Instructions

## Project Overview

Spades Online is a real-time multiplayer card game (web + mobile) built with a Node.js backend and React Native / Flutter mobile clients. The server manages all game state authoritatively; clients are intentionally thin. Data is persisted in a primary database with Redis used for session management, lobby state, and presence.

## Architecture

- `server/app.js` — Entry point, Express server, listens on PORT (default 3000)
- `server/server.js` — All API route handlers (exported as named `handler`)
- `server/game/` — Core game engine: deal, bid, trick, scoring, bag tracking, win detection
- `server/lobby/` — Table creation, lobby browser, seat management, host controls
- `server/social/` — Friends, invites, block, notifications, presence
- `server/chat/` — In-game chat, profanity filter, abuse reporting
- `server/ws/` — WebSocket server, real-time event broadcasting
- `server/anticheat/` — Server-side move validation, card visibility enforcement
- `client/web/` — Web frontend (React, responsive desktop + tablet)
- `client/mobile/` — React Native (or Flutter) iOS + Android app
- Redis — Lobby state, active sessions, presence, pub/sub for WebSocket events
- Primary DB — Persistent storage: accounts, game history, profiles, friends

## Branch Strategy

- `main` — production, deployment target, do not touch
- `dev` — primary integration branch
- `qa` — pre-prod validation

## How Claude Should Work

- Create a new branch per task, branched from `dev`, using a `claude/` prefix and descriptive name e.g. `claude/feat/blind-nil-exchange`, `claude/fix/bag-deduction`
- Always open PRs targeting `dev`, never `main`
- Never commit directly to `main`, `dev`, or `qa`
- Keep PRs small and focused — one feature or fix per PR
- Write a clear PR description explaining what changed and why

## Code Style

- ES Modules throughout (`import`/`export`, never `require`)
- Async/await preferred over callbacks or raw promises
- Console.log for debugging is fine, include context e.g. `console.log('Playing card:', { gameId, playerId, card })`
- No TypeScript, no build step on the server; client build handled by bundler
- All game rule logic must live in `server/game/` — never in client code

## API Conventions

- All API routes live under `/api/`
- Responses always use `sendJSON(res, statusCode, data)`
- Auth is handled via headers: `x-session-id`, `x-player-id`, `x-table-id`
- Redis keys:
  - `lobby:tables` — active public table index
  - `table:{tableId}` — table config and seat state
  - `session:{sessionId}` — player session
  - `presence:{playerId}` — online/in-game status
- Table state expires after 3600 seconds (1 hour) of inactivity
- WebSocket events follow the pattern `{ type: 'EVENT_NAME', payload: { ... } }`

## Game Engine Rules (Critical)

The game engine is the most sensitive part of the codebase. Before modifying anything in `server/game/`, understand:

- **All game state lives on the server.** Clients receive only what they are allowed to see — a player never receives another player's hand until cards are played.
- **Partnership bidding:** the second bidder sets the team's combined total, overriding the first bidder's number. Nil and Blind Nil bids are individual and always stand regardless of the partner's team bid.
- **Blind Nil eligibility:** only available when the player's team is at least 100 points behind. Only one player per team may bid Blind Nil per hand. Requires a 2-card exchange (Blind Nil player sends 2 cards to partner first, then partner sends 2 back).
- **Bags:** overtricks count +1 each; every 10 bags deducts 100 points from the team's score. Tricks taken by a nil bidder count toward their partner's bid and become bags if they cause the partner to exceed it.
- **First trick:** Spades may not be played on the first trick even if a player is void in the led suit.
- **Spades breaking:** Spades cannot be led until a Spade has been played on a non-Spade lead (after the first trick).
- **Win condition:** first team to 250 points wins. If both reach 250 in the same round, the higher score wins.
- **Turn order:** bidding and play begin with the player to the dealer's left, proceeding clockwise.

When in doubt about a rule, refer to `docs/spades_prd.md` Section 5.

## Real-Time & Anti-Cheat

- All game actions (play card, place bid) go through `server/anticheat/` validation before being applied to game state
- The anti-cheat layer must verify: it is the player's turn, the card is in their hand, the card is a legal play under current game rules
- Never broadcast a player's hand to any other client — only broadcast played cards and public bid information
- WebSocket connections are authenticated on upgrade using the player's session token

## Environment Variables

- `DATABASE_URL` — Primary database connection string (required)
- `REDIS_URL` — Redis connection string (required)
- `PORT` — Server port (default 3000)
- `NODE_ENV` — Environment name
- `WS_PORT` — WebSocket server port (default 3001, can share with HTTP)
- `PUSH_API_KEY` — Push notification service API key
- `GIT_BRANCH` — Current branch (set by CI)
- `GIT_COMMIT_SHA` — Current commit (set by CI)
- `APP_URL` — Public URL of the deployment

## Testing

- **Write tests before making code changes** — follow a test-first (TDD) approach for all new functionality and bug fixes
- New functionality: write the test first, then implement to make it pass
- Bug fixes: write a regression test that reproduces the bug first, then fix it
- Use Node's built-in `node:test` runner (see `test/` for existing tests)
- Test locations:
  - `test/unit/game/` — pure game logic (scoring, bidding, trick resolution, bag counting)
  - `test/unit/anticheat/` — move validation logic
  - `test/integration/` — API routes and Redis behaviour
  - `test/ws/` — WebSocket event flow
- Every new API route must have at least one integration test
- Every change to game rules must have corresponding unit tests covering the affected rule
- Tests run against a real Redis instance — no mocking
- Run `npm test` to execute the full test suite
- Do not break existing API contracts — clients depend on exact response and event shapes

## Dependency Management

- After adding or changing npm dependencies, always run `npm install` to update `package-lock.json`
- Commit `package.json` and `package-lock.json` together — CI uses `npm ci`

## README

- Keep `README.md` up to date whenever changes affect: features, API routes, WebSocket events, environment variables, or local development setup
- Update the README in the same PR as the code change — never leave them out of sync

## Things to Be Careful About

- **Card visibility is a security boundary.** Any bug that leaks hand information to the wrong client is a critical defect.
- Redis lobby state is rebuilt from the primary DB on server restart — do not treat Redis as the source of truth for anything that must survive a restart.
- WebSocket pub/sub uses Redis — changes to event schemas must be backward compatible or coordinated with a client release.
- Bag deduction logic runs at the end of each hand — verify it does not double-deduct if a hand is replayed or resumed.
- Partnership bidding override (second bidder sets team total) is easy to get wrong — the first bidder's number is advisory only, except when they bid Nil or Blind Nil.
- Blind Nil card exchange must complete before play begins and must be validated server-side (correct count, correct direction).
- CORS headers are set manually on every request — do not remove them.

## Open Questions (Unresolved — Do Not Implement Until Decided)

These items from the PRD are not yet scoped. Do not build them without an explicit decision being recorded:

- **OQ-1:** Premium pricing model (subscription vs. one-time bundles vs. both)
- **OQ-2:** Individual bidding mode alongside partnership bidding
- **OQ-3:** Fixed vs. configurable score target for ranked games
- **OQ-4:** Shared vs. separate MMR for Solo Queue and Duo Queue
- **OQ-5:** Spectator chat-only mode vs. observe-only

## Out of Scope for v1.0

Do not implement the following unless the milestone explicitly changes:

- Bots / AI opponents (v1.1)
- Spectating (v1.1)
- Ranked play and MMR (v1.2)
- Premium cosmetics and billing (v1.3)
- Ruleset customization (v1.3)
- Game variants: Cutthroat, Suicide, Whiz, Mirrors (v2.0)
