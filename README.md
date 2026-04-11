# Spades Online

Real-time multiplayer Spades card game — web and mobile.

## Architecture

| Layer | Technology |
|---|---|
| Server | Node.js + Express (ES Modules, no build step) |
| Real-time | WebSocket (shares HTTP server by default; configurable via WS_PORT) |
| Session / Lobby / Presence | Redis |
| Persistent storage | PostgreSQL |
| Mobile | React Native / Flutter (iOS 15+, Android 10+) |

## Local Development

### Prerequisites

- Node.js 18+
- PostgreSQL
- Redis

### Setup

```bash
# Install dependencies
npm install

# Set required environment variables (copy and edit as needed)
export DATABASE_URL="postgresql://user:password@localhost:5432/spades"
export REDIS_URL="redis://localhost:6379"

# Run database migrations
psql $DATABASE_URL -f db/migrations/001_create_players.sql
psql $DATABASE_URL -f db/migrations/002_create_profile_and_games.sql
psql $DATABASE_URL -f db/migrations/003_create_password_reset_tokens.sql

# Start the server (default port 3000)
npm start
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string |
| `PORT` | No | `3000` | HTTP server port |
| `WS_PORT` | No | Same as `PORT` | WebSocket server port. Defaults to sharing the HTTP server. Set to a different port to run WebSocket on a dedicated server (requires a reverse proxy to route WebSocket upgrades from the HTTP port). |
| `WS_URL` | No | Derived from request origin | Full WebSocket base URL (e.g. `wss://my-app.up.railway.app`). Set this in split-host deployments where the WebSocket server is on a different host than the frontend (e.g. Vercel + Railway). The server injects this as `window.__WS_URL__` in the served HTML so the client connects to the correct host. |
| `NODE_ENV` | No | — | Environment name (`development`, `production`) |
| `APP_URL` | No | `http://localhost:3000` | Public base URL (used in verification emails) |
| `EMAIL_HOST` | No | — | SMTP host. If unset, verification emails are logged to stdout |
| `EMAIL_PORT` | No | `587` | SMTP port |
| `EMAIL_SECURE` | No | `false` | Set `true` for TLS on port 465 |
| `EMAIL_USER` | No | — | SMTP username |
| `EMAIL_PASS` | No | — | SMTP password |
| `EMAIL_FROM` | No | `noreply@spades.online` | From address for outbound email |
| `PUSH_API_KEY` | No | — | Push notification service API key |
| `GIT_BRANCH` | No | — | Current branch (set by CI) |
| `GIT_COMMIT_SHA` | No | — | Current commit SHA (set by CI) |
| `AUTH_RATE_LIMIT_MAX` | No | `10` | Max auth requests per window (unauthenticated endpoints) |
| `AUTH_RATE_LIMIT_WINDOW` | No | `900` | Rate limit window in seconds (default: 15 min) |
| `DEV_AUTO_VERIFY` | No | — | Set to `true` to skip email verification on registration. **Local dev only — never set in production.** |

### Dev & Testing Tools

These tools exist to make manual testing easier during development. They are not production features.

#### `DEV_AUTO_VERIFY` — skip email verification

If you do not have an SMTP server configured, you cannot verify more than one account using the normal email flow. Set `DEV_AUTO_VERIFY=true` when starting the server:

```bash
DEV_AUTO_VERIFY=true npm start
```

With this flag set, `POST /api/auth/register` marks accounts as verified immediately — no email is sent, no token is required, and you can log in straight away. The flag is read at request time, so it can be toggled without a restart.

#### Bot players — fill seats for solo testing

The table host can fill any empty seat with a bot:

```http
POST /api/tables/:tableId/add-bot
Headers: x-session-id, x-player-id
Body: { "seat": "north" }  // or "east", "south", "west"
```

Bot behaviour:
- **Bid:** counts the number of spades in its hand and bids that number
- **Play:** picks a random card from the set of legal plays

Bot turns are processed server-side automatically — after each human action (bid or card play), the server immediately plays all consecutive bot turns until it is a human's turn again. The human player just polls `GET /api/tables/:tableId/state` as normal.

Bot player IDs follow the pattern `bot:<seat>` (e.g. `bot:north`). A table can have any mix of human and bot seats. Once all 4 seats are filled (by humans and/or bots), the game starts automatically.

If a human player leaves a table mid-game, their seat is immediately filled by a bot so the game can continue.

> These bots are intentionally minimal — they are a testing convenience, not the production AI opponent planned for v1.1.

### Running Tests

```bash
npm test
```

Unit tests run without any external services. Integration tests require `DATABASE_URL` to be set and will be skipped otherwise.

## API Routes

All routes are under `/api/`. Responses always use `{ ... }` JSON. Auth routes use headers `x-session-id`, `x-player-id`, `x-table-id` where applicable.

### Build Info

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/build-info` | None | Returns the short git commit SHA of the running server. |

#### `GET /api/build-info`

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: `{ commitShort: "<7-char SHA>" }` or `{ commitShort: null }` if `GIT_COMMIT_SHA` is not set |

### Player Profiles

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/profile/:playerId` | Get a player's public profile (username, avatar, career stats, recent games, cosmetics). |

#### `GET /api/profile/:playerId`

**Responses**

| Status | Meaning |
|---|---|
| `200` | Profile found. Body: `{ playerId, username, avatar, cosmetics, career, recentGames }` |
| `400` | `playerId` is not a valid UUID |
| `404` | Player not found |

**Response body**
```json
{
  "playerId": "uuid",
  "username": "alice",
  "avatar": { "icon": 3 },
  "cosmetics": { "feltColor": "green", "cardBack": "standard-red" },
  "career": { "wins": 10, "losses": 5 },
  "recentGames": [
    {
      "gameId": "uuid",
      "playedAt": "2026-03-01T12:00:00Z",
      "won": true,
      "scoreNs": 260,
      "scoreEw": 150,
      "seat": "north"
    }
  ]
}
```

### Authentication

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Register with email, username, password. Sends a verification email. |
| `GET` | `/api/auth/verify-email?token=<uuid>` | Verify email address using the token from the registration email. |
| `POST` | `/api/auth/resend-verification` | Resend the verification email to an unverified account. Always returns 200 regardless of whether the email exists (prevents enumeration). |
| `POST` | `/api/auth/login` | Authenticate with email and password. Returns a session token. |
| `POST` | `/api/auth/logout` | Invalidate the current session. |
| `POST` | `/api/auth/forgot-password` | Request a password reset email. Always returns 200 (prevents enumeration). |
| `POST` | `/api/auth/reset-password` | Reset password using a valid reset token from the email. |

#### `POST /api/auth/register`

**Body**
```json
{ "email": "alice@example.com", "username": "alice", "password": "hunter2abc" }
```

**Responses**

| Status | Meaning |
|---|---|
| `201` | Registered. Verification email sent. Body: `{ message, playerId }` |
| `400` | Missing or invalid fields (e.g. password < 8 chars) |
| `409` | Email or username already in use |

#### `GET /api/auth/verify-email?token=<uuid>`

**Responses**

| Status | Meaning |
|---|---|
| `200` | Email verified. Account is now active. |
| `400` | Missing, invalid, expired, or already-used token |

#### `POST /api/auth/resend-verification`

**Body**
```json
{ "email": "alice@example.com" }
```

**Responses**

| Status | Meaning |
|---|---|
| `200` | Request accepted. If the email is registered and unverified, a new link has been sent. |
| `500` | Internal server error |

> Note: A `200` is returned even when the email is not found or the account is already verified. This prevents account enumeration.

#### `POST /api/auth/login`

**Body**
```json
{ "email": "alice@example.com", "password": "hunter2abc" }
```

**Responses**

| Status | Meaning |
|---|---|
| `200` | Login successful. Body: `{ sessionId, playerId, username }` |
| `400` | Missing or invalid fields |
| `401` | Invalid credentials |
| `403` | Account email not yet verified |

#### `POST /api/auth/logout`

**Headers:** `x-session-id`

**Responses**

| Status | Meaning |
|---|---|
| `200` | Session invalidated. Body: `{ message }` |

#### `POST /api/auth/forgot-password`

**Body**
```json
{ "email": "alice@example.com" }
```

**Responses**

| Status | Meaning |
|---|---|
| `200` | Request accepted. If the email is registered, a reset link has been sent. |
| `500` | Internal server error |

> Note: Always returns `200` regardless of whether the email exists (prevents enumeration). The reset link expires in 1 hour.

#### `POST /api/auth/reset-password`

**Body**
```json
{ "token": "<reset-token-from-email>", "newPassword": "newpassword123" }
```

**Responses**

| Status | Meaning |
|---|---|
| `200` | Password updated. Player can now sign in with the new password. |
| `400` | Missing/invalid token, expired token, or password too short |
| `500` | Internal server error |

### Tables & Lobby

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/tables` | Required | List all open (waiting) tables. |
| `GET` | `/api/player/table` | Required | Returns the `tableId` the authenticated player is currently seated at, or `null`. |
| `POST` | `/api/tables` | Required | Create a new table. |
| `POST` | `/api/tables/:tableId/sit` | Required | Sit at an empty seat. Starts the game once all 4 seats are filled. |
| `POST` | `/api/tables/:tableId/add-bot` | Required (host) | Add a bot to an empty seat. |
| `POST` | `/api/tables/:tableId/leave` | Required | Leave the table. If a game is in progress, the vacated seat is immediately filled by a bot. |
| `POST` | `/api/tables/:tableId/terminate` | Required (host) | Terminate the game at any phase. |

#### `GET /api/tables`

**Headers:** `x-session-id`, `x-player-id`

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: `{ tables: [{ tableId, name, seats, hostPlayerId }] }` — only waiting (not yet started) tables |
| `401` | Missing or invalid session |

`seats` is an object keyed by seat name (`north`, `east`, `south`, `west`). Each value is either `null` (empty) or `{ playerId, username, isBot }`.

#### `GET /api/player/table`

**Headers:** `x-session-id`, `x-player-id`

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: `{ "tableId": "<uuid>" }` or `{ "tableId": null }` |
| `401` | Missing or invalid session |

#### `POST /api/tables`

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "name": "Alice's Table" }
```

`name` is optional (max 50 characters). If omitted, a default name is used.

**Responses**

| Status | Meaning |
|---|---|
| `201` | Table created. Body: `{ tableId, name }` |
| `400` | Name is not a string or exceeds 50 characters |
| `401` | Missing or invalid session |

#### `POST /api/tables/:tableId/sit`

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "seat": "north" }
```

Valid seat values: `north`, `east`, `south`, `west`.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Seated. Body: `{ tableId, seat }`. Game starts automatically if all 4 seats are now filled. |
| `400` | Invalid seat value |
| `401` | Missing or invalid session |
| `404` | Table not found |
| `409` | Game already in progress, seat is taken, or player is already seated at this table |

#### `POST /api/tables/:tableId/add-bot`

Host-only. See [Bot players](#bot-players----fill-seats-for-solo-testing) in the Dev & Testing Tools section.

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "seat": "north" }
```

**Responses**

| Status | Meaning |
|---|---|
| `200` | Bot added. Body: `{ tableId, seat }`. Game starts automatically if all 4 seats are now filled. |
| `400` | Invalid seat value |
| `401` | Missing or invalid session |
| `403` | Caller is not the table host |
| `404` | Table not found |
| `409` | Game already in progress or seat is taken |

#### `POST /api/tables/:tableId/leave`

**Headers:** `x-session-id`, `x-player-id`

Removes the player from their seat. If a game is in progress when the player leaves, a bot is automatically placed in the vacated seat and any consecutive bot turns are immediately processed.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Left table. Body: `{ message }` |
| `401` | Missing or invalid session |
| `404` | Table not found |
| `409` | Player is not seated at this table |

#### `POST /api/tables/:tableId/terminate`

Host-only. Ends the game and removes the table regardless of phase.

**Headers:** `x-session-id`, `x-player-id`

**Responses**

| Status | Meaning |
|---|---|
| `200` | Game terminated. Body: `{ message }` |
| `401` | Missing or invalid session |
| `403` | Caller is not the table host |
| `404` | Table not found |

### Game

All game routes require the caller to be seated at the table. Game state responses are filtered so each player only sees their own hand.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/tables/:tableId/state` | Required | Get the current game state filtered for the authenticated player. |
| `POST` | `/api/tables/:tableId/bid` | Required | Place a bid during the bidding phase. |
| `POST` | `/api/tables/:tableId/reveal-hand` | Required | Reveal hand before bidding (forfeits Blind Nil eligibility). |
| `POST` | `/api/tables/:tableId/blind-nil-exchange` | Required | Submit cards for the Blind Nil card exchange. |
| `POST` | `/api/tables/:tableId/play` | Required | Play a card during the playing phase. |

#### `GET /api/tables/:tableId/state`

**Headers:** `x-session-id`, `x-player-id`

Returns a player-specific view of the game. Cards in other players' hands are never included.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: game state view (see below), or `{ status: "waiting", seats, isHost, hostSeat }` if the game has not started yet. `seats` is an object keyed by seat name; each value is `null` (empty) or `{ playerId, username, isBot }`. |
| `401` | Missing or invalid session |
| `403` | Player is not seated at this table |
| `404` | Table not found |

The game state view includes: `phase`, `hand` (own cards only), `bids`, `tricks`, `scores`, `bags`, `currentPlayerSeat`, `currentBidderSeat`, `isHost`, `hostSeat`, and other phase-specific fields. It never includes another player's hand.

During the `playing` phase, when it is the requesting player's turn to play, the response also includes `validCards`: an array of card objects representing the legal plays available to that player (computed server-side via `getLegalPlays`). This field is omitted when it is not the player's turn. Clients may use it to highlight or restrict UI affordances, but the server re-validates every play regardless.

#### `POST /api/tables/:tableId/bid`

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "bid": 3 }
```

Valid bid values: `0` (Nil), `-1` (Blind Nil, only if eligible), or `1`–`13`.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Bid accepted. Body: updated player view. Bot turns auto-advance before response. |
| `400` | Invalid bid value or not eligible for Blind Nil |
| `401` | Missing or invalid session |
| `403` | Player is not seated at this table |
| `404` | Table not found |
| `409` | Not the player's turn to bid, or game not in bidding phase |

#### `POST /api/tables/:tableId/reveal-hand`

**Headers:** `x-session-id`, `x-player-id`

Reveals the player's hand so they can see their cards before deciding whether to bid Blind Nil. Only valid during the bidding phase when the player has not yet bid. Once revealed, the player can no longer bid Blind Nil.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Hand revealed. Body: updated player view (hand is now visible). |
| `400` | Player is not eligible to use reveal-hand |
| `401` | Missing or invalid session |
| `403` | Player is not seated at this table |
| `404` | Table not found |
| `409` | Bid already placed, or game not in bidding phase |

#### `POST /api/tables/:tableId/blind-nil-exchange`

**Headers:** `x-session-id`, `x-player-id`

Submit cards for the Blind Nil card exchange. The Blind Nil player sends 2 cards to their partner first; the partner then sends 2 cards back. Both steps are submitted via this endpoint. The exchange must complete before play begins.

**Body**
```json
{ "cards": ["AS", "KS"] }
```

**Responses**

| Status | Meaning |
|---|---|
| `200` | Exchange step accepted. Body: updated player view. Bot turns auto-advance if partner is a bot. |
| `400` | Wrong number of cards, cards not in hand, or invalid card format |
| `401` | Missing or invalid session |
| `403` | Player is not seated at this table |
| `404` | Table not found |
| `409` | Not this player's step in the exchange, or game not in blind nil exchange phase |

#### `POST /api/tables/:tableId/play`

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "card": "AS" }
```

Card format: rank + suit initial (e.g. `AS` = Ace of Spades, `KH` = King of Hearts, `2C` = 2 of Clubs, `TD` = 10 of Diamonds).

**Responses**

| Status | Meaning |
|---|---|
| `200` | Card played. Body: updated player view. Bot turns auto-advance before response. |
| `400` | Card not in hand or illegal play (e.g. following suit required, spades not broken) |
| `401` | Missing or invalid session |
| `403` | Player is not seated at this table |
| `404` | Table not found |
| `409` | Not the player's turn, or game not in playing phase |

## Real-Time (WebSocket)

The WebSocket server shares the HTTP server by default (same port as `PORT`). Set `WS_PORT` to a different port to run it on a dedicated server — in that case a reverse proxy must route WebSocket upgrades from the public HTTP port to `WS_PORT`.

### Connection & Authentication

Clients must authenticate on the WebSocket upgrade request by including the session token as a header:

```
GET ws://localhost:3001/
x-session-id: <sessionId>
```

If the header is missing or the session is invalid the server responds with `HTTP 401` and closes the socket. No anonymous connections are accepted.

### Client → Server Messages

All messages are JSON: `{ "type": "<TYPE>", "payload": { ... } }`.

| Type | Payload | Description |
|---|---|---|
| `JOIN` | `{ "tableId": "<uuid>" }` | Subscribe to real-time events for a table. Acknowledged with `JOINED`. |
| `LEAVE` | `{ "tableId": "<uuid>" }` | Unsubscribe from a table's events. Acknowledged with `LEFT`. |
| `JOIN_LOBBY` | `{}` | Subscribe to lobby-wide events (table created/removed). Acknowledged with `JOINED_LOBBY`. |
| `LEAVE_LOBBY` | `{}` | Unsubscribe from lobby events. Acknowledged with `LEFT_LOBBY`. |

### Server → Client Events

| Type | Payload | Description |
|---|---|---|
| `JOINED` | `{ "tableId": "<uuid>" }` | Confirms the client has joined the table room. |
| `LEFT` | `{ "tableId": "<uuid>" }` | Confirms the client has left the table room. |
| `JOIN_DENIED` | `{ "tableId": "<uuid>", "reason": "not_seated" \| "table_not_found" \| "error" }` | Sent when a `JOIN` request is rejected because the player is not seated at the table, the table does not exist, or an internal error occurred. |
| `JOINED_LOBBY` | `{}` | Confirms the client has joined the lobby channel. |
| `LEFT_LOBBY` | `{}` | Confirms the client has left the lobby channel. |

Game events (bid placed, card played, trick complete, etc.) are broadcast to all clients in the table room using the same envelope: `{ "type": "<EVENT_NAME>", "payload": { ... } }`.

Lobby events (table created, table removed, etc.) are broadcast to all lobby subscribers across all server instances via Redis pub/sub using the same envelope: `{ "type": "<EVENT_NAME>", "payload": { ... } }`.

### Heartbeat

The server sends a WebSocket ping every **30 seconds**. Clients must respond with a pong (handled automatically by standard WebSocket implementations). If no pong is received within **10 seconds** of the ping, the connection is terminated.

## Web UI

The web client is served as static files from `client/web/` by the Express server. Open `http://localhost:3000` in a browser after starting the server.

Current screens:
- **Sign In** (`#/login`) — email + password login; shows a "Resend verification email" button when login fails with an unverified email error; includes a "Forgot your password?" link
- **Create Account** (`#/register`) — registration with email, username, and password; shows a verification prompt on success with a "Resend verification email" button
- **Forgot Password** (`#/forgot-password`) — email input form; shows a "check your email" confirmation on submit (always, to prevent enumeration)
- **Reset Password** (`#/reset-password?token=<uuid>`) — new password form; shows success screen on completion or an error screen for invalid/expired links
- **Lobby** (`#/lobby`) — main menu after login; shows options to create or join a table; redirects back to the game screen if the player is already seated
- **Create Table** (`#/create`) — form to create a new table with an optional name; redirects to the join screen for the new table on success
- **Join Table** (`#/join?tableId=<id>`) — browsable list of open tables; if `?tableId=` is provided, shows the seat picker for that specific table directly
- **Game** (`#/table?tableId=<id>`) — in-game screen; handles bidding, Blind Nil reveal/exchange, card play, and end-of-hand summaries

On successful login the session is stored in `sessionStorage` (`sessionId`, `playerId`, `username`) and the player is routed to `#/lobby`.

## Project Structure

```
client/
  web/
    index.html        — SPA entry point (served at /)
    src/
      main.js         — App entry; registers routes and starts the router
      router.js       — Hash-based SPA router
      validation.js   — Pure form-validation helpers (shared with unit tests)
      api.js          — Fetch wrappers for all API endpoints
      redirectIfSeated.js — Redirects seated players back to their table
      seatUtils.js    — Seat orientation helpers
      hand.js         — Card hand rendering helpers
      trickHold.js    — Trick animation / hold logic
      inputBlock.js   — Input blocking during async actions
      endOfHandSummary.js — End-of-hand summary rendering
      icons.js        — SVG icon constants
      screens/
        login.js          — Sign-in screen
        register.js       — Registration screen
        forgotPassword.js — Forgot password request screen
        resetPassword.js  — Reset password form and landing screens
        lobby.js          — Lobby (main menu after login)
        createTable.js    — Create table screen
        joinTable.js      — Join table / seat picker screen
        game.js           — In-game screen (bidding, card play, end-of-hand)
server/
  app.js          — Express entry point (also serves client/web as static)
  server.js       — All API route handlers
  db.js           — Shared PostgreSQL pool
  redis.js        — Shared Redis client
  auth/
    registration.js  — Registration and email-verification logic
    login.js         — Login and credential validation
    session.js       — Session creation, lookup, and deletion
    passwordReset.js — Forgot/reset password logic
    email.js         — Email builders and senders (verification + password reset)
  social/
    profile.js      — Player profile data access
  game/
    state.js        — Game state machine (create, bid, play, score)
    bid.js          — Bidding logic and partnership bid resolution
    deck.js         — Deck creation and dealing
    trick.js        — Trick resolution
    score.js        — Scoring, bag counting, win detection
    bot.js          — Bot player logic (bid and card selection)
  lobby/
    table.js        — Table creation, seat management, lobby index
  ws/
    index.js        — WebSocket server (auth upgrade, JOIN/LEAVE rooms, heartbeat, broadcast helpers)
  anticheat/
    validate.js     — Server-side move validation (turn, card legality)
  middleware/
    rateLimiter.js  — Redis-backed per-IP rate limiter
db/
  migrations/
    001_create_players.sql
    002_create_profile_and_games.sql
    003_create_password_reset_tokens.sql
test/
  unit/
    auth/           — Pure logic tests (no DB required)
    web/            — Web client unit tests (validation, API client)
    game/           — Game engine unit tests (scoring, bidding, tricks, bags)
    anticheat/      — Move validation unit tests
    lobby/          — Lobby and table management unit tests
    middleware/     — Rate limiter unit tests
  integration/
    auth/           — Auth API route tests (requires DATABASE_URL)
    social/         — Profile API route tests (requires DATABASE_URL)
    game/           — Game API route tests (requires DATABASE_URL + Redis)
docs/
  spades_prd.md   — Product requirements (source of truth for all rules)
  TASKS.md        — Task checklist
```

## Branch Strategy

| Branch | Purpose |
|---|---|
| `main` | Production — do not commit directly |
| `dev` | Primary integration branch |
| `qa` | Pre-prod validation |

All PRs target `dev`.
