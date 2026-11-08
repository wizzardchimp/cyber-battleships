# Cyber Battleships — Architecture

Stage 1 implements a real-time lobby: facilitator console, projector display and
mobile player terminals stay synchronised through a server-authoritative game
session. Questions, ships, attacks, captains and scoring are deliberately out of
scope until Stage 2.

## Runtime components

```
Browser clients                    Node.js server                    PostgreSQL
┌───────────────┐   HTTP/WS   ┌──────────────────────────┐      ┌──────────────┐
│ /host         │◀──────────▶│ Express (REST + auth)     │      │ sessions     │
│ /display      │            │ Socket.IO gateway         │◀────▶│ teams        │
│ /play         │            │ SessionManager            │      │ players      │
└───────────────┘            │ GameSession (authority)   │      │ session_     │
                             │ Projections (safe views)  │      │ events       │
                             └──────────────────────────┘      └──────────────┘
```

- **Express** serves the built Vite client, facilitator auth, public session
  summary, QR SVG, the short `/<CODE>` player redirect and health check.
- **Socket.IO** carries all live operations. Each socket has a role
  (`host`, `display`, `player`) and joins a `session:<id>` room.
- **`SessionManager`** owns the in-memory session registry, join-code allocation,
  expiry cleanup and restart restoration.
- **`GameSession`** is the authoritative state machine for one lobby. It validates
  every command, mutates state, records an event and emits `change`.
- **Projections** build role-safe payloads. They are constructed field by field,
  never by spreading the session snapshot, so token hashes and future secret
  state cannot leak.
- **`SessionRepository`** persists a JSONB snapshot plus normalised lobby rows in
  one transaction.

## State model

```js
{
  id, joinCode, name, phase,          // lobby | mission_ready | ended
  config,                             // validated session config
  teams: [{ id, name, color, maxPlayers, ... }],
  players: [{ id, displayName, nameKey, teamId, role, tokenHash, connected, stats }],
  recentEvents: [...], eventSeq, version,
  createdAt, updatedAt, startedAt, endedAt, expiresAt,
  joinBaseUrl, displayBaseUrl
}
```

- The server is the only writer. Clients send intents (`player:join`,
  `player:chooseTeam`, `host:lockLobby`, `host:start`, ...) and render the next
  `state` event.
- A monotonic `version` and the `meta.phase` field let clients detect stale or
  out-of-order projections.
- `recentEvents` powers the facilitator event stream and client toasts; the same
  events are appended to `session_events` for audit history.

## Socket lifecycle

### Player join

1. `player:join { code, name, teamId?, asSpectator? }`
2. `GameSession.join()` validates phase, lock, name uniqueness and capacity, then
   creates a player with a 32-byte resume token. Only the SHA-256 token hash is
   stored.
3. The snapshot is committed, the socket joins the session room and receives
   `player:ok { playerId, token, ... }`, immediately followed by a player-scoped
   `state` projection.

### Resume / reconnect

- The browser stores `{ token, playerId, name }` in `localStorage` under
  `cb.player.<CODE>`.
- On reconnect it sends `player:resume { code, token }`. The server hashes the
  token and re-attaches the same player identity, cancelling the pending offline
  timer.
- A second device resuming the same token supersedes the old socket. Stale
  sockets are removed from the live map immediately so disconnect bookkeeping
  stays correct.
- If a socket drops without resuming, the player is marked offline after an
  8-second grace period (`LIMITS.reconnectGraceMs`).

### Host and display

- `/api/host/login` verifies `ADMIN_PIN` and issues an HMAC-signed HttpOnly
  cookie. Socket connections are authenticated from the same cookie.
- `host:subscribe` and `display:subscribe` attach the socket to a session room.
  The host receives the extended projection (all roles, events, `admin.canStart`);
  the display receives the public projection only.

## Commands and transitions

| Event | Authority | Effect |
| --- | --- | --- |
| `host:subscribe` | facilitator cookie | attach host projection |
| `host:lockLobby` | host | block/imply new joins |
| `host:movePlayer` | host | reassign a player between teams |
| `host:removePlayer` | host | delete participant and disconnect them |
| `host:renameTeam` | host | rename a team while in lobby |
| `host:start` | host | force-start a round, enter `mission_ready`, lock lobby |
| `display:start` | display | force-start a round from the Battle Command lobby |
| `host:returnToLobby` | host | return `mission_ready` → `lobby` |
| `player:chooseTeam` | player | switch teams while lobby is open |
| `player:resume` | token holder | reattach an existing identity |

`canStart()` still reports the normal readiness rules (at least one player, and
in team/co-op modes at least one player on every configured team), but the
facilitator and display start commands use a forced start so an event can begin
with an empty or partially populated lobby. Only the phase check is enforced.

All socket handlers validate payloads with Zod, apply a per-socket rate limit and
return an acknowledgement `{ ok: true }` or
`{ ok: false, error: { code, message } }`.

## Database schema (Stage 1)

- `sessions` — one row per operation: code, status/phase, mode, config JSONB,
  full state JSONB, version, timestamps, expiry.
- `teams` — normalised team rows for reporting and future scoring.
- `players` — normalised participant rows, including `token_hash` (unique per
  session/name) and connection timestamps.
- `session_events` — append-only event log keyed by `(session_id, seq)`.

Migrations live in `server/db/migrations` and are applied automatically on
startup. The JSONB snapshot is the recovery source of truth; normalised tables
are rebuilt from it on every save.

### Database drivers

- `DATABASE_URL` present → `pg` connection pool against PostgreSQL (Railway).
- `DATABASE_URL` absent → embedded PGlite. Tests use an in-memory instance;
  local development uses `data/pglite`.

Both drivers expose the same `query`/`transaction` interface.

## Restart and failure recovery

- On boot the manager loads non-expired sessions ordered newest first.
- Restored players are marked `connected = false` because no sockets survived the
  restart. Their resume tokens remain valid.
- Clients retry the socket connection and call `player:resume` /
  `host:subscribe` using the session in the URL. The lobby therefore survives a
  server restart without players re-entering their names.
- Sessions expire after `SESSION_RETENTION_HOURS` (default 24) and are removed by
  a periodic cleanup task.
- Commits are serialised per session and broadcast immediately; persistence
  failures surface as `PERSISTENCE_ERROR` without silently losing the in-memory
  state.

## Security boundaries

- Facilitator auth: global PIN → signed, HttpOnly, SameSite=Lax cookie with a
  12-hour lifetime. Login is throttled per IP.
- Player auth: per-player random token, stored only as a hash; compare on resume.
- Public/display/player projections never include `tokenHash`, `nameKey` or host
  event data.
- All input is length-limited and sanitised; Zod schemas are shared by client and
  server.
- Helmet sets a strict CSP; Socket.IO origins are restricted to the same host
  plus `ALLOWED_ORIGINS`.

## Stage 2 extension points

- New phases extend `PHASES` and `GameSession` transition methods.
- Question/fleet/attack state can be persisted in the session JSONB and exposed
  through new scoped projections.
- `session_events` already provides the audit trail for answers, hits and scoring.
- The `teams` table reserves missile, weapon, target and stats columns for fleet
  combat without another schema rewrite.
