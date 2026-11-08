# Cyber Battleships

A real-time, multi-device cyber-security awareness game. Players enlist from
phones, answer timed security questions to earn missiles, then fire those
missiles at opposing battle grids while a facilitator console and projector
display keep the room in sync.

> Stage 2 scope: the live lobby plus complete playable rounds — timed questions,
> missile rewards, attack grids, scoring, winners and repeated rounds with
> cumulative scores. Accounts, persistent leaderboards and after-action
> reporting remain out of scope.

## Stack

- **Node.js 20 + Express + Socket.IO** — server-authoritative state, role-scoped
  broadcasts.
- **PostgreSQL (Railway)** in production, **embedded PGlite** for local
  development and tests.
- **Vanilla ES modules + Vite** — separate facilitator, display and player pages.
- **Vanilla CSS** with a shared token system; mobile-first player terminal.

## Quick start (local)

```bash
npm install
npm run dev
```

Open the Vite URL printed by the command (usually <http://localhost:5173>).
`npm run dev` starts the API on port 3000 and Vite with `/api` and
`/socket.io` proxies.

For a single production-style process:

```bash
npm run build
ADMIN_PIN=123456 \
COOKIE_SECRET=0123456789abcdef0123456789abcdef \
npm start
```

Then open:

| Surface | URL | Purpose |
| --- | --- | --- |
| Landing | <http://localhost:3000/> | Describe the drill and link the consoles |
| Facilitator | <http://localhost:3000/host> | Create, lock and start operations |
| Projector | <http://localhost:3000/display?code=CODE> | Full-screen joining QR, live questions and battle boards |
| Players (short link) | <http://localhost:3000/CODE> | Redirects to `/play?code=CODE` for phones |
| Players (full link) | <http://localhost:3000/play?code=CODE> | Mobile questions, attack grid and scoreboard |

Each operation gets a short entry link — `/<CODE>` — which redirects to the player
app. QR codes encode this short URL, and the host and projector show it directly
below the code so players can scan or type a few characters.

The server prints the LAN address, join URL and — if you did not supply one — a
generated facilitator PIN on startup.

## Facilitator flow

1. Open `/host` and enter the `ADMIN_PIN`.
2. **NEW OPERATION** → choose mode, team count, capacity and other settings.
3. Project the display via **OPEN DISPLAY** and show the six-character join code
   and short URL beneath the QR.
4. Players scan the QR or open the short `/<CODE>` link, enter a display name and
   choose a team.
5. Use the live roster to **MOVE** or **REMOVE** players and **LOCK LOBBY** to
   close enlistment. Existing players can still reconnect while locked.
6. **START ROUND** from the facilitator console or the projected Battle Command
   lobby launches immediately, even with no players or empty teams. The room
   enters the question phase and fleets are generated for every combatant.
7. The facilitator console shows the live question, the answer key, per-option
   tallies, every fleet and the scoreboard. **ADVANCE** jumps from questions to
   the attack phase, then closes the round; **END ROUND** closes it immediately
   and **NEXT ROUND** launches the next one. **RETURN TO LOBBY** reopens the room
   and clears scores, fleets and ammunition.
8. **Allow late joining** lets new devices enlist during an active round. Team
   modes drop them into a team that already has a fleet and missile pool; free-
   for-all adds them to the ring with a fresh fleet. Turn it off to close
   enlistment at the start.
9. The **age category** caps how advanced questions can get: cadets see easy and
   medium questions, juniors can reach hard, and adults can reach expert.

## Player flow

- One device per player; no account or install required.
- The resume token is stored in `localStorage`, so a refresh or network drop
  restores the same player and team automatically.
- If the same identity resumes from another device, the older socket is
  superseded and told why.
- **Question phase:** tap one of four answers. Correct answers earn 3 missiles
  within 5 seconds, 2 within 10, or 1 within 20. Answering correctly also scores
  10 points. The correct answer and explanation appear after everyone answers or
  the timer expires.
- **Joining late:** when the facilitator allows it, you can enlist mid-round. Team
  modes share their existing fleet and missile pool; free-for-all starts you with
  a fresh fleet and a place in the targeting ring.
- **Attack phase:** tap a cell on your target grid to fire one missile. Hits
  score 25 points, sinking a ship adds 50, and the scoreboard updates live.
- **Round over:** the winner and your points, hits, correct answers and remaining
  missiles are shown until the facilitator starts the next round.

## Game loop

```
START ROUND → QUESTION (repeat for roundMinutes)
            → ATTACK (max(10, tacticalSeconds))
            → ROUND OVER → NEXT ROUND or RETURN TO LOBBY
```

- Questions are drawn at random from a server-side bank filtered by the configured
  difficulty and capped by the age band. Each question runs for `questionTimer`
  seconds, followed by a 4-second answer reveal, until the round's quiz clock
  expires.
- Teams and co-op crews share one missile pool and one fleet; free-for-all
  players each own a fleet and target each other in a ring. A CPU firewall is
  added whenever a lone player has no human opponent (and in co-op).
- `maxAttacksPerTeam` caps shots per combatant in the attack phase, and
  `ammoCarryOver` decides whether unused missiles survive into the next round.
- Scores accumulate across rounds until the facilitator returns to the lobby;
  fleets are regenerated every round.
- Correct answers, fleet positions and answer keys are withheld from public and
  player projections until the reveal; only the host console sees them early.

## Configuration

Copy `.env.example` to `.env` and adjust. Important variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_URL` | Railway domain / LAN | Base URL used in QR codes and join links |
| `ADMIN_PIN` | generated per run | Facilitator console PIN (min 4 chars) |
| `COOKIE_SECRET` | generated per run | Signs the facilitator cookie (min 24 chars) |
| `DATABASE_URL` | empty | PostgreSQL URL; empty uses embedded PGlite |
| `PGSSL` | on in production | Set `false` for a local Postgres without TLS |
| `DATA_DIR` | `./data` | PGlite data directory |
| `SESSION_RETENTION_HOURS` | `24` | Automatic session expiry |
| `ALLOWED_ORIGINS` | empty | Extra Socket.IO origins, comma separated |

## Scripts

```bash
npm run dev        # API + Vite dev server
npm run dev:server # API only, with watch
npm run dev:client # Vite only
npm run build      # Production client bundle → dist/client
npm start          # Serve API + built client
npm test           # Unit + integration tests (PGlite in memory)
npm run test:watch # Tests in watch mode
```

## Tests

The suite covers:

- Lobby engine rules: joining, unique names, capacity, team switching, moving,
  kick, lock, start/return transitions and free-for-all mode.
- Round engine rules: answer rewards, incorrect answers, public answer secrecy,
  missile consumption, hits and sinking, per-round limits, phase timers, results,
  cumulative scores, ammo carry-over and lobby reset.
- Audience and join rules: age bands cap question difficulty; late joining can be
  enabled for live team and free-for-all rounds, or disabled outright.
- Facilitator auth: signed tokens, expiry, tampering, PIN checks and login
  throttling.
- Projection safety: no `tokenHash`, `nameKey` or private fields in public,
  display, host-event or player payloads, and no answer key before reveal.
- Integration: 20 real Socket.IO clients join a lobby, balance across teams,
  stay synchronised on the host console and projector, switch teams, get locked
  out, resume after a reconnect and reach the first question.
- End to end: two players answer a live question, earn missiles, advance to the
  attack phase, register a hit, see the round winner and start round two.
- Recovery: a lobby and its players survive a full server restart on the same
  PGlite directory and can resume with the original tokens.

```bash
npm test
```

## Deploy to Railway

1. Create a Railway project and add the **PostgreSQL** plugin.
2. Deploy this repository. `railway.json` runs `npm ci && npm run build` and
   starts with `npm start`; the health check is `/healthz`.
3. Set `ADMIN_PIN`, `COOKIE_SECRET` and (optionally) `PUBLIC_URL`. Railway
   provides `DATABASE_URL` automatically; TLS is enabled by default in
   production.
4. Generate a public domain. QR codes and join links use it automatically.

Sessions and player tokens are persisted in PostgreSQL, so redeploys do not lose
an active lobby. Players resume automatically when their browser reconnects.

## Run with Docker

```bash
docker compose up --build
```

This starts PostgreSQL 16 and the app on <http://localhost:3000>. Set `ADMIN_PIN`
and `COOKIE_SECRET` in the environment or a `.env` file to override the local
defaults.

## Project layout

```
client/
  index.html, host.html, display.html, play.html
  src/{landing,host,display,play}/main.js
  src/shared/            # api, socket, audio, clock, dom, battle grid helpers
  styles/                # tokens + per-surface CSS
server/
  app.js                 # Express routes, auth, QR, static serving
  auth.js                # PIN login, signed host cookie, throttle
  realtime/socket.js     # socket roles, commands, broadcasts, reconnect
  sessions/session.js    # authoritative GameSession state machine
  sessions/round.js      # fleets, combatants, targeting and scoring helpers
  sessions/manager.js    # lifecycle, join codes, restore, cleanup, round tick
  sessions/projections.js# role-safe views
  db/                    # PGlite/Postgres adapter, migrations, repository
shared/                  # constants, questions, events, schemas, utilities
test/                    # node:test unit + integration suites
docs/architecture.md     # deeper design notes
```

## Troubleshooting

- **Facilitator PIN unknown** — check the server console. It is printed when
  `ADMIN_PIN` is not set, and changes on every run unless you set it.
- **“Client bundle not built”** — run `npm run build` before `npm start`, or use
  `npm run dev`.
- **Phones cannot reach the QR URL** — ensure devices are on the same network and
  use the LAN address printed at startup, or set `PUBLIC_URL` to a reachable
  host.
- **Postgres TLS errors locally** — set `PGSSL=false` for a local database
  without TLS.

## Next stages

Captains, special weapons, achievements, persistent leaderboards and after-action
reporting. The session JSONB snapshot, event log and reserved team columns are
designed to absorb those features without replacing the lobby or round engine.
