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
psql $DATABASE_URL -f db/migrations/004_create_friendships.sql
psql $DATABASE_URL -f db/migrations/005_create_player_blocks.sql

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
| `GIT_COMMIT_SHA` | No | — | Current commit SHA (set by CI). If not set, the server checks `VERCEL_GIT_COMMIT_SHA` (Vercel) and `COMMIT_REF` (Netlify), then falls back to `git rev-parse HEAD`. |
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

### Linting

```bash
npm run lint
```

Runs ESLint against the `test/integration` directory. This check also runs in CI before the test suite.

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

### Social / Friends

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/players/search?username=<query>` | Required | Search players by username prefix (case-insensitive). Rate limited. |
| `POST` | `/api/friends/request` | Required | Send a friend request. Rate limited. |
| `POST` | `/api/friends/accept` | Required | Accept a pending friend request. |
| `POST` | `/api/friends/decline` | Required | Decline a pending friend request. |
| `GET` | `/api/friends` | Required | List accepted friends and pending incoming requests. |
| `DELETE` | `/api/friends/:playerId` | Required | Remove an accepted friend. |
| `GET` | `/api/friends/:friendId/table` | Required | Check if a friend is at a visible table and whether "Go to Table" is available. |
| `POST` | `/api/friends/:friendId/go-to-table` | Required | Navigate to a friend's table as an observer. |
| `POST` | `/api/players/:playerId/block` | Required | Block a player. Removes any existing friendship and pending requests. |
| `DELETE` | `/api/players/:playerId/block` | Required | Unblock a player. |
| `GET` | `/api/players/blocked` | Required | List all players you have blocked. |

#### `GET /api/players/search`

**Headers:** `x-session-id`, `x-player-id`

**Query parameters:** `username` — prefix to search (required, max 50 characters). The requesting player is excluded from results. Returns up to 20 matches ordered alphabetically.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: `{ players: [{ playerId, username }] }` |
| `400` | Missing or invalid username query |
| `401` | Missing or invalid session |

#### `POST /api/friends/request`

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "playerId": "<uuid>" }
```

**Responses**

| Status | Meaning |
|---|---|
| `201` | Friend request sent. Publishes `FRIEND_REQUEST_RECEIVED` to the recipient's personal notification channel. |
| `400` | Invalid playerId or attempting to friend yourself |
| `401` | Missing or invalid session |
| `403` | Either player has blocked the other |
| `404` | Target player not found |
| `409` | Already friends or request already pending |

#### `POST /api/friends/accept`

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "playerId": "<uuid>" }
```

The `playerId` is the requester whose pending request you want to accept.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Friend request accepted. Publishes `FRIEND_REQUEST_ACCEPTED` to the original requester's personal notification channel. If either player hosts a friends-only table, `TABLE_CREATED` is sent to the new friend's personal notification channel for each such table. |
| `400` | Invalid playerId |
| `401` | Missing or invalid session |
| `403` | Either player has blocked the other |
| `404` | No pending friend request found |

#### `POST /api/friends/decline`

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "playerId": "<uuid>" }
```

The `playerId` is the requester whose pending request you want to decline. The friendship row is deleted.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Friend request declined |
| `400` | Invalid playerId |
| `401` | Missing or invalid session |
| `403` | Either player has blocked the other |
| `404` | No pending friend request found |

#### `GET /api/friends`

**Headers:** `x-session-id`, `x-player-id`

Returns two arrays: `friends` (accepted friendships, enriched with presence and table info) and `pending` (incoming requests awaiting your response).

Each entry in `friends` includes:
- `presenceStatus` — `"online"`, `"in-game"`, or `"offline"` (absent presence key is treated as offline).
- `tableInfo` — `null` when the friend is not in a game; otherwise `{ tableName }`. The `tableName` is disclosed only when the requester is permitted to see it: public tables always disclose, friends-only tables disclose only when the requester is also a friend of the table host, private tables (and missing/expired tables) return `tableName: null`.

`pending` entries are not enriched with presence or table info.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: `{ friends: [{ playerId, username, since, presenceStatus, tableInfo }], pending: [{ playerId, username, sentAt }] }` |
| `401` | Missing or invalid session |

#### `DELETE /api/friends/:playerId`

**Headers:** `x-session-id`, `x-player-id`

Removes an accepted friendship. Both directions are deleted. If either player hosts a friends-only table, `TABLE_REMOVED` is sent to the other player's personal notification channel for each such table.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Friend removed |
| `400` | Invalid playerId |
| `401` | Missing or invalid session |
| `404` | Friendship not found |

#### `GET /api/friends/:friendId/table`

**Headers:** `x-session-id`, `x-player-id`

Checks whether a friend is currently at a table that is visible to the requester. Returns the table info and whether the "Go to Table" action is available (based on spectating and join policy). Returns `{ table: null }` if the friend is not at a table or the table is not visible.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: `{ table: { tableId, name, hostPlayerId, status, visibility, spectating } \| null, canGoToTable: boolean }` |
| `401` | Missing or invalid session |
| `403` | Not friends with this player |

#### `POST /api/friends/:friendId/go-to-table`

**Headers:** `x-session-id`, `x-player-id`

Navigates to a friend's table as an observer. Requires that the table is visible to the requester and that either spectating is enabled or the requester has seating rights under the table's join policy. Broadcasts `OBSERVER_JOINED` to the table room.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: `{ tableId }` — successfully arrived at the table |
| `401` | Missing or invalid session |
| `403` | Not friends, table not visible, or no permission to go to table |
| `404` | Friend is not at a table |
| `409` | Observers full or concurrent modification |

#### `POST /api/players/:playerId/block`

**Headers:** `x-session-id`, `x-player-id`

Blocks the target player. If a friendship or pending friend request exists between the two players (in either direction), it is removed. If the players were friends and either hosts a friends-only table, `TABLE_REMOVED` is sent to the other player's personal notification channel for each such table. Blocking is idempotent — blocking an already-blocked player succeeds silently.

**Responses**

| Status | Meaning |
|---|---|
| `201` | Player blocked |
| `400` | Invalid playerId or attempting to block yourself |
| `401` | Missing or invalid session |
| `404` | Target player not found |

#### `DELETE /api/players/:playerId/block`

**Headers:** `x-session-id`, `x-player-id`

Unblocks the target player. After unblocking, the players can send friend requests to each other again. The previous friendship is not restored — they must re-add each other.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Player unblocked |
| `400` | Invalid playerId |
| `401` | Missing or invalid session |
| `404` | Block not found |

#### `GET /api/players/blocked`

**Headers:** `x-session-id`, `x-player-id`

Returns the list of players blocked by the authenticated player, ordered by most recently blocked first.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: `{ blocked: [{ playerId, username, blockedAt }] }` |
| `401` | Missing or invalid session |

### Tables & Lobby

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/tables` | Required | List all open (waiting) public tables. |
| `GET` | `/api/lobby/tables` | Required | Public lobby browser. Only returns tables whose `visibility` is `public`. Optional query params: `hasSeats=true` (only tables with an open seat), `search=<string>` (case-insensitive substring match on table name). Filters compose. |
| `GET` | `/api/player/table` | Required | Returns the `tableId` the authenticated player is currently seated at, or `null`. |
| `POST` | `/api/tables` | Required | Create a new table. |
| `POST` | `/api/tables/:tableId/arrive` | Required | Arrive at a table as an observer. Requires spectating to be enabled (unless player has a join link). |
| `POST` | `/api/tables/:tableId/sit` | Required | Sit at an empty seat. Enforces the table's join policy. Starts the game once all 4 seats are filled. |
| `POST` | `/api/tables/:tableId/join` | Required | Join a table as a spectator (observer). Requires spectating to be enabled on the table. |
| `POST` | `/api/tables/:tableId/sit` | Required | Sit at an empty seat. Starts the game once all 4 seats are filled. |
| `POST` | `/api/tables/:tableId/add-bot` | Required (host) | Add a bot to an empty seat. |
| `POST` | `/api/tables/:tableId/leave` | Required | Leave the table. If a game is in progress, the vacated seat is immediately filled by a bot. |
| `GET` | `/api/tables/:tableId/join-link` | Required (host) | Generate a single-use shareable join link for the table. |
| `POST` | `/api/tables/join-link/:token` | Required | Use a join link to sit at the table. Bypasses join policy. |
| `POST` | `/api/tables/:tableId/spectator-link` | Required (host) | Generate a shareable spectator link for the table. |
| `POST` | `/api/tables/spectator-link/:token` | Required | Use a spectator link to join a table as an observer. |
| `POST` | `/api/tables/:tableId/transfer-host` | Required (host) | Transfer host privileges to another seated human player. |
| `POST` | `/api/tables/:tableId/kick` | Required (host) | Kick a player (seated or observer) from the table. During an active game the seat is filled by a bot. |
| `POST` | `/api/tables/:tableId/assign-seat` | Required (host) | Move a seated player to a different empty seat (waiting tables only). |
| `POST` | `/api/tables/:tableId/visibility` | Required (host) | Change the table's visibility (public, friends-only, private). |
| `POST` | `/api/tables/:tableId/terminate` | Required (host) | Terminate the game at any phase. |

#### `GET /api/tables`

**Headers:** `x-session-id`, `x-player-id`

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: `{ tables: [{ tableId, name, hostPlayerId, hostUsername, seats, seatsAvailable, observerCount, joinPolicy, visibility, ruleset, spectating }] }` — only waiting (not yet started) public tables |
| `401` | Missing or invalid session |

`seats` is an object keyed by seat name (`north`, `east`, `south`, `west`). Each value is either `null` (empty) or `{ playerId, username, isBot }`. `hostUsername` is the host's display name (or `null` if unavailable). `seatsAvailable` is the count of empty seats. `observerCount` is the number of spectators currently watching the table. `joinPolicy`, `visibility`, and `ruleset` mirror the table's configuration (defaults: `"open"`, `"public"`, `"Standard"`). `spectating` indicates whether the host has enabled spectating.

The response from `GET /api/lobby/tables` has the same shape.

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
{ "name": "Alice's Table", "visibility": "public", "joinPolicy": "open", "spectating": true }
```

All fields are optional:
- `name` — table display name (max 50 characters). If omitted, a default name is used.
- `visibility` — `"public"` (default), `"friends-only"`, or `"private"`. Controls who can see the table in the lobby.
- `joinPolicy` — `"open"`, `"friends-only"`, or `"invite-only"`. Must be compatible with the chosen visibility (see below). If omitted, defaults to the most permissive policy allowed by the visibility. If an incompatible value is provided, the request is rejected with `400`.
- `spectating` — `true` (default) or `false`. Whether spectators can watch the table.

**Visibility / join policy compatibility:**

| Visibility | Allowed join policies | Default |
|---|---|---|
| `public` | `open`, `friends-only`, `invite-only` | `open` |
| `friends-only` | `friends-only`, `invite-only` | `friends-only` |
| `private` | `invite-only` | `invite-only` |

**Responses**

| Status | Meaning |
|---|---|
| `201` | Table created. Body: `{ tableId, name, visibility, joinPolicy, spectating }` |
| `400` | Invalid name, visibility, joinPolicy, or spectating value |
| `401` | Missing or invalid session |

#### `POST /api/tables/:tableId/arrive`

**Headers:** `x-session-id`, `x-player-id`

Arrives at the table as an observer. The table must have spectating enabled unless the player holds a valid join link. If the player is already seated or already an observer, the call is idempotent and returns the current table state.
#### `POST /api/tables/:tableId/join`

**Headers:** `x-session-id`, `x-player-id`

Joins the table as a spectator (observer). The table must have spectating enabled. Players who arrive via this endpoint can watch the game but cannot sit down — use a join link or the `/sit` endpoint to take a seat.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Arrived as observer. Body: `{ tableId }` |
| `401` | Missing or invalid session |
| `403` | Spectating is disabled for this table |
| `404` | Table not found |
| `409` | Observer slots are full, or concurrent modification — retry |

#### `POST /api/tables/:tableId/sit`

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "seat": "north" }
```

Valid seat values: `north`, `east`, `south`, `west`.

The table's join policy is enforced: `open` allows anyone, `friends-only` requires friendship with the host, and `invite-only` requires a prior invitation (e.g. via join link). The host always passes policy checks.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Seated. Body: `{ tableId, seat }`. Game starts automatically if all 4 seats are now filled. |
| `400` | Invalid seat value |
| `401` | Missing or invalid session |
| `403` | Player is a spectator-only observer, or join policy forbids seating |
| `404` | Table not found |
| `409` | Game already in progress, seat is taken, player is already seated, or concurrent modification — retry |

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

#### `POST /api/tables/:tableId/spectator-link`

Host-only. Generates a shareable spectator link that any authenticated player can use to join the table as an observer. Unlike join links, spectator links are **multi-use** — they are not consumed after a single use. The token is stored in Redis and expires with the same TTL as the table (1 hour of inactivity). Spectating must be enabled on the table.

**Headers:** `x-session-id`, `x-player-id`

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: `{ token, spectatorUrl }`. `spectatorUrl` is a full URL using `APP_URL` (e.g. `https://spades.online/spectate/<token>`). |
| `401` | Missing or invalid session |
| `403` | Caller is not the table host, or spectating is disabled for this table |
| `404` | Table not found |

#### `POST /api/tables/spectator-link/:token`

Validates a spectator-link token and adds the authenticated player to the table as an observer. The player is marked as spectator-only and **cannot sit down** at the table even if the join policy would normally allow it. The token is not consumed — it can be reused by multiple players.

**Headers:** `x-session-id`, `x-player-id`

**Responses**

| Status | Meaning |
|---|---|
| `200` | Joined as observer. Body: `{ tableId }` |
| `401` | Missing or invalid session |
| `403` | Invalid or expired spectator link, or spectating is disabled |
| `404` | Table no longer exists |
| `409` | Observer slots are full |

#### `POST /api/tables/:tableId/transfer-host`

Host-only. Transfers host privileges to another seated human player. Works in both waiting and playing states. The target must be seated at the table and must not be a bot.

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "playerId": "<target-player-uuid>" }
```

**Responses**

| Status | Meaning |
|---|---|
| `200` | Host transferred. Body: `{ tableId, hostPlayerId, newHostSeat }` |
| `400` | Target player is not seated at the table, or target is a bot |
| `401` | Missing or invalid session |
| `403` | Caller is not the current host |
| `404` | Table not found |
| `409` | Concurrent modification — retry the request |

#### `POST /api/tables/:tableId/kick`

Host-only. Kicks a player from the table. The target can be a seated player or an observer. During a waiting table, the seat is vacated (set to `null`). During an active game, the kicked player's seat is filled by a bot. If no human players remain after the kick, the table is terminated. The host cannot kick themselves.

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "playerId": "<targetPlayerId>" }
```

**Responses**

| Status | Meaning |
|---|---|
| `200` | Player kicked. Body: updated table state, or `{ message }` if the table was terminated. |
| `400` | Missing `playerId` in body, host tried to kick themselves, or target player is not at the table. |
| `401` | Missing or invalid session |
| `403` | Caller is not the table host |
| `404` | Table not found |

**WebSocket events:**
- `PLAYER_KICKED` is broadcast to the table room with `{ playerId, seat }` (seat is `null` if the target was an observer).
- `KICKED_FROM_TABLE` is sent to the kicked player's personal notification channel with `{ tableId }`.

#### `POST /api/tables/:tableId/visibility`

Host-only. Changes the table's visibility setting. When the visibility changes, the server updates the lobby index and fires the appropriate transition events:

- Leaving `public`: `TABLE_REMOVED` is broadcast to the lobby channel.
- Entering `public`: `TABLE_CREATED` is broadcast to the lobby channel.
- Leaving `friends-only`: `TABLE_REMOVED` is sent to each of the host's friends via their personal notification channels.
- Entering `friends-only`: `TABLE_CREATED` is sent to each of the host's friends via their personal notification channels.
- `private` produces no lobby or friend notifications in either direction.

A `TABLE_VISIBILITY_CHANGED` event is always broadcast to the table room so seated players and observers are informed.

The table's `joinPolicy` is automatically adjusted to remain compatible with the new visibility (e.g. changing to `private` forces `invite-only`).

If the new visibility matches the current visibility, the request succeeds as a no-op — no events are fired.

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "visibility": "friends-only" }
```

Valid values: `public`, `friends-only`, `private`.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Visibility changed. Body: `{ tableId, visibility, joinPolicy }` |
| `400` | Invalid visibility value |
| `401` | Missing or invalid session |
| `403` | Caller is not the table host |
| `404` | Table not found |

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

#### `POST /api/tables/:tableId/assign-seat`

Host-only. Moves a seated player to a different empty seat. Only allowed while the table is in `waiting` status.

**Headers:** `x-session-id`, `x-player-id`

**Body**
```json
{ "playerId": "<target-player-id>", "seat": "south" }
```

Valid seat values: `north`, `east`, `south`, `west`.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Seat assigned. Body: `{ tableId, seat }` |
| `400` | Missing required fields or invalid seat value |
| `401` | Missing or invalid session |
| `403` | Caller is not the table host |
| `404` | Table not found |
| `409` | Game in progress, target player not seated, or target seat is occupied |
| `503` | Concurrent modification — retry the request |

If the player is already in the requested seat, the call succeeds as a no-op (200) without broadcasting any WebSocket events.

#### `GET /api/tables/:tableId/join-link`

Host-only. Generates a single-use join link that any authenticated player can use to sit at the table, bypassing the table's `joinPolicy`. The token is stored in Redis and expires with the same TTL as the table (1 hour of inactivity).

**Headers:** `x-session-id`, `x-player-id`

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: `{ token, joinUrl }`. `joinUrl` is a full URL using `APP_URL` (e.g. `https://spades.online/join/<token>`). |
| `401` | Missing or invalid session |
| `403` | Caller is not the table host |
| `404` | Table not found |

#### `POST /api/tables/join-link/:token`

Validates and consumes a single-use join link token, then seats the player at the associated table. The token is deleted on use so it cannot be reused. The table's `joinPolicy` is intentionally bypassed — the link itself serves as host authorization.

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
| `403` | Invalid or expired join link |
| `404` | Table no longer exists |
| `409` | Game already in progress, seat is taken, or player is already seated |

### Game

All game action routes (bid, play, reveal-hand, blind-nil-exchange) require the caller to be seated at the table. The state endpoint is also accessible to spectators. Game state responses are filtered so each player only sees their own hand; spectators receive a public-only view with no hand data.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/tables/:tableId/state` | Required | Get the current game state filtered for the authenticated player. |
| `POST` | `/api/tables/:tableId/bid` | Required | Place a bid during the bidding phase. |
| `POST` | `/api/tables/:tableId/reveal-hand` | Required | Reveal hand before bidding (forfeits Blind Nil eligibility). |
| `POST` | `/api/tables/:tableId/blind-nil-exchange` | Required | Submit cards for the Blind Nil card exchange. |
| `POST` | `/api/tables/:tableId/play` | Required | Play a card during the playing phase. |

#### `GET /api/tables/:tableId/state`

**Headers:** `x-session-id`, `x-player-id`

Returns a player-specific view of the game. Cards in other players' hands are never included. Spectators (observers) receive a public-only view with `status: "spectating"` — it includes seats, scores, and phase but never `myHand` or `hands`.

**Responses**

| Status | Meaning |
|---|---|
| `200` | Body: game state view (see below), `{ status: "waiting", seats, isHost, hostSeat }` if the game has not started yet, or `{ status: "spectating", seats, phase, scores, ... }` for spectators. `seats` is an object keyed by seat name; each value is `null` (empty) or `{ playerId, username, isBot }`. |
| `401` | Missing or invalid session |
| `403` | Player is not seated at or observing this table |
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
| `JOIN_DENIED` | `{ "tableId": "<uuid>", "reason": "not_seated" \| "table_not_found" \| "error" }` | Sent when a `JOIN` request is rejected because the player is neither seated at nor observing the table, the table does not exist, or an internal error occurred. |
| `JOINED_LOBBY` | `{}` | Confirms the client has joined the lobby channel. |
| `LEFT_LOBBY` | `{}` | Confirms the client has left the lobby channel. |

| `OBSERVER_JOINED` | `{ "playerId": "<uuid>", "username": "<string>" }` | Broadcast to the table room when a player joins as a spectator-only observer (via a spectator link or the friends list "Go to Table" action). |
| `OBSERVER_LEFT` | `{ "playerId": "<uuid>" }` | Broadcast to the table room when an observer leaves the table. |

| `HOST_CHANGED` | `{ "newHostPlayerId": "<uuid>", "newHostSeat": "<north\|east\|south\|west>" }` | Broadcast when the host transfers host privileges to another player. |
| `PLAYER_KICKED` | `{ "playerId": "<uuid>", "seat": "<north\|east\|south\|west>" \| null }` | Broadcast when the host kicks a player. `seat` is `null` if the kicked player was an observer. |

Game events (bid placed, card played, trick complete, etc.) are broadcast to all clients in the table room using the same envelope: `{ "type": "<EVENT_NAME>", "payload": { ... } }`. **Observers (spectators) are excluded from events that contain private hand data:** `HAND_DEALT`, `HAND_REVEALED`, and `BLIND_NIL_EXCHANGE_PROMPT` are never sent to observer connections.

Lobby events are routed based on table visibility using the same envelope: `{ "type": "<EVENT_NAME>", "payload": { ... } }`.

- **Public** tables broadcast on the `lobby` Redis pub/sub channel, reaching all lobby subscribers across all server instances.
- **Friends-Only** tables send the same events to each of the host's friends via their personal `player:{friendId}:notify` notification channels (using `wss.notifyPlayer`). The events never appear on the public lobby channel.
- **Private** tables produce no broadcast at all.

| Type | Payload | Description |
|---|---|---|
| `TABLE_CREATED` | `{ tableId, name, host, seats, visibility }` | A table was created. Routed by visibility. |
| `TABLE_UPDATED` | `{ tableId, name, host, seats, status, visibility, observerCount, spectating }` | A table's state changed (seat taken/vacated, game started, observer joined, etc.). Routed by visibility. |
| `TABLE_REMOVED` | `{ tableId }` | A table was removed (terminated, all players left, or expired). Routed by visibility. |
| `TABLE_VISIBILITY_CHANGED` | `{ tableId, visibility, oldVisibility, joinPolicy }` | Broadcast to the table room when the host changes the table's visibility. Not routed via lobby — only sent to clients subscribed to the table. |

### Personal Notification Channel

Each authenticated WebSocket connection is automatically subscribed to a personal `player:{playerId}:notify` Redis pub/sub channel. This channel delivers social events (friend requests, in-app invites, friends-only table notifications) directly to the target player across all server instances. No client action is required — the subscription happens on connect and is cleaned up on disconnect.

Server-side code can send a notification to any online player via `wss.notifyPlayer(playerId, type, payload)`. When Redis is configured, the message is published to the player's notification channel so all server instances deliver it. Without Redis, it falls back to a local `sendToPlayer` call.

#### Notification Events

| Type | Payload | Trigger |
|---|---|---|
| `FRIEND_REQUEST_RECEIVED` | `{ "fromPlayerId": "<uuid>", "fromUsername": "<string>" }` | A friend request is sent to this player. |
| `FRIEND_REQUEST_ACCEPTED` | `{ "fromPlayerId": "<uuid>", "fromUsername": "<string>" }` | A player accepts this player's friend request. |
| `KICKED_FROM_TABLE` | `{ "tableId": "<uuid>" }` | The player was kicked from a table by the host. |

### Heartbeat

The server sends a WebSocket ping every **30 seconds**. Clients must respond with a pong (handled automatically by standard WebSocket implementations). If no pong is received within **10 seconds** of the ping, the connection is terminated.

## Web UI

The web client is served as static files from `client/web/` by the Express server. Open `http://localhost:3000` in a browser after starting the server.

Current screens:
- **Sign In** (`#/login`) — email + password login; shows a "Resend verification email" button when login fails with an unverified email error; includes a "Forgot your password?" link
- **Create Account** (`#/register`) — registration with email, username, and password; shows a verification prompt on success with a "Resend verification email" button
- **Forgot Password** (`#/forgot-password`) — email input form; shows a "check your email" confirmation on submit (always, to prevent enumeration)
- **Reset Password** (`#/reset-password?token=<uuid>`) — new password form; shows success screen on completion or an error screen for invalid/expired links
- **Lobby** (`#/lobby`) — main menu after login; shows options to create or join a table and a friends panel with presence badges (online / in-game / offline) that polls `GET /api/friends` every 30 seconds; redirects back to the game screen if the player is already seated
- **Create Table** (`#/create`) — form to create a new table with an optional name, visibility, join policy, and spectator toggle; redirects to the join screen for the new table on success
- **Join Table** (`#/join?tableId=<id>`) — browsable list of open tables; if `?tableId=` is provided, shows the seat picker for that specific table directly
- **Game** (`#/table?tableId=<id>`) — in-game screen; handles bidding, Blind Nil reveal/exchange, card play, end-of-hand summaries, and an observer rail showing current spectators

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
      buildIndicator.js — Build commit indicator UI module
      redirectIfSeated.js — Redirects seated players back to their table
      friendsPanel.js — Friends list panel with presence badges (mounted on the lobby screen)
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
  presence.js     — Redis presence state machine (online / playing / disconnect cleanup)
  auth/
    registration.js  — Registration and email-verification logic
    login.js         — Login and credential validation
    session.js       — Session creation, lookup, and deletion
    passwordReset.js — Forgot/reset password logic
    email.js         — Email builders and senders (verification + password reset)
  social/
    profile.js      — Player profile data access
    block.js        — Player blocking and block-check logic
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
    index.js        — WebSocket server (auth upgrade, JOIN/LEAVE rooms, heartbeat, broadcast helpers, personal notification channels)
  anticheat/
    validate.js     — Server-side move validation (turn, card legality)
  middleware/
    rateLimiter.js  — Redis-backed per-IP rate limiter
db/
  migrations/
    001_create_players.sql
    002_create_profile_and_games.sql
    003_create_password_reset_tokens.sql
    004_create_friendships.sql
    005_create_player_blocks.sql
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
    social/         — Profile and friends API route tests (requires DATABASE_URL)
    game/           — Game API route tests (requires DATABASE_URL + Redis)
  ws/               — WebSocket event flow tests
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
