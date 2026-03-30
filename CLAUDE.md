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

- Before starting any task, check `docs/TASKS.md` for the current task list and pick up an incomplete item
- Create a new branch per task, branched from `dev`, using a `claude/` prefix and descriptive name e.g. `claude/feat/blind-nil-exchange`, `claude/fix/bag-deduction`
- Always open PRs targeting `dev`, never `main`
- Never commit directly to `main`, `dev`, or `qa`
- Keep PRs small and focused — one feature or fix per PR
- Write a clear PR description explaining what changed and why
- Mark the corresponding task complete in `docs/TASKS.md` in the same PR as the code change

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

`docs/spades_prd.md` Section 5 is the sole source of truth for all game rules. Do not infer, guess, or simplify rules — read the PRD before implementing anything in `server/game/`.

The following are coding-specific gotchas that are easy to misimplement even when the rules are understood correctly:

- **Card visibility is a security boundary.** Never send a player's hand to any other client — only broadcast cards at the moment they are played.
- **Partnership bidding:** the first bidder's number is advisory only. The second bidder's combined team total overrides it. The exception — Nil and Blind Nil — are individual bids that always stand. It is easy to accidentally treat the first bidder's number as the team bid.
- **Blind Nil card exchange direction:** the Blind Nil player sends first, then the partner sends back. The order matters and must be enforced server-side.
- **Bag deduction:** runs at the end of each hand — verify it cannot double-deduct if a hand is resumed or replayed.
- **Nil bidder tricks:** tricks won by a nil bidder count toward the partner's bid and become bags if they push the partner over. This is a separate code path from normal bag accumulation and easy to miss.

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

## Scope & Open Questions

`docs/TASKS.md` is the actionable task list for v1.0. `docs/spades_prd.md` Sections 7 and 9 are the source of truth for unresolved decisions and out-of-scope features. Do not implement anything listed in the open questions or post-launch sections without an explicit decision being recorded in the PRD first.
