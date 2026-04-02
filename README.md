# Spades Online

Real-time multiplayer Spades card game — web and mobile.

## Architecture

| Layer | Technology |
|---|---|
| Server | Node.js + Express (ES Modules, no build step) |
| Real-time | WebSocket (WS_PORT, defaults to 3001) |
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

# Start the server (default port 3000)
npm start
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `REDIS_URL` | Yes | — | Redis connection string |
| `PORT` | No | `3000` | HTTP server port |
| `WS_PORT` | No | `3001` | WebSocket server port (can share with HTTP) |
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

> These bots are intentionally minimal — they are a testing convenience, not the production AI opponent planned for v1.1.

### Running Tests

```bash
npm test
```

Unit tests run without any external services. Integration tests require `DATABASE_URL` to be set and will be skipped otherwise.

## API Routes

All routes are under `/api/`. Responses always use `{ ... }` JSON. Auth routes use headers `x-session-id`, `x-player-id`, `x-table-id` where applicable.

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

## Web UI

The web client is served as static files from `client/web/` by the Express server. Open `http://localhost:3000` in a browser after starting the server.

Current screens:
- **Sign In** (`#/login`) — email + password login; shows a "Resend verification email" button when login fails with an unverified email error; includes a "Forgot your password?" link
- **Create Account** (`#/register`) — registration with email, username, and password; shows a verification prompt on success with a "Resend verification email" button
- **Forgot Password** (`#/forgot-password`) — email input form; shows a "check your email" confirmation on submit (always, to prevent enumeration)
- **Reset Password** (`#/reset-password?token=<uuid>`) — new password form; shows success screen on completion or an error screen for invalid/expired links

On successful login the session is stored in `sessionStorage` (`sessionId`, `playerId`, `username`) and the player is routed to `#/lobby` (lobby screen, coming in a later slice).

## Project Structure

```
client/
  web/
    index.html        — SPA entry point (served at /)
    src/
      main.js         — App entry; registers routes and starts the router
      router.js       — Hash-based SPA router
      validation.js   — Pure form-validation helpers (shared with unit tests)
      api.js          — Fetch wrappers for auth API endpoints
      screens/
        login.js          — Sign-in screen
        register.js       — Registration screen
        forgotPassword.js — Forgot password request screen
        resetPassword.js  — Reset password form and landing screens
server/
  app.js          — Express entry point (also serves client/web as static)
  server.js       — All API route handlers
  db.js           — Shared PostgreSQL pool
  auth/
    registration.js  — Registration and email-verification logic
    passwordReset.js — Forgot/reset password logic
    email.js         — Email builders and senders (verification + password reset)
  social/
    profile.js      — Player profile data access
db/
  migrations/
    001_create_players.sql
    002_create_profile_and_games.sql
    003_create_password_reset_tokens.sql
test/
  unit/
    auth/           — Pure logic tests (no DB required)
    web/            — Web client unit tests (validation, API client)
  integration/
    auth/           — API route tests (requires DATABASE_URL)
    social/         — Profile API route tests (requires DATABASE_URL)
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
