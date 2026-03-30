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

### Running Tests

```bash
npm test
```

Unit tests run without any external services. Integration tests require `DATABASE_URL` to be set and will be skipped otherwise.

## API Routes

All routes are under `/api/`. Responses always use `{ ... }` JSON. Auth routes use headers `x-session-id`, `x-player-id`, `x-table-id` where applicable.

### Authentication

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Register with email, username, password. Sends a verification email. |
| `GET` | `/api/auth/verify-email?token=<uuid>` | Verify email address using the token from the registration email. |

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

## Project Structure

```
server/
  app.js          — Express entry point
  server.js       — All API route handlers
  db.js           — Shared PostgreSQL pool
  auth/
    registration.js — Registration and email-verification logic
    email.js        — Verification email builder and sender
db/
  migrations/
    001_create_players.sql
test/
  unit/
    auth/           — Pure logic tests (no DB required)
  integration/
    auth/           — API route tests (requires DATABASE_URL)
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
