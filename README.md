# CYBER BATTLESHIPS

A real-time, multiplayer cyber-security awareness game. A presenter console drives the
session, a projector shows the battlespace, and every player answers and fires from
their phone. No build step, no CDN assets, no audio files — everything runs from a
single Node process on a laptop (or a container on Railway).

## What's in the box

- `server/` — Node + Express + Socket.IO authoritative game server.
- `public/` — three browser clients: `host.html` (presenter), `display.html` (projector),
  `play.html` (phone controller).
- `server/questions.seed.json` — 30 bundled cyber-security questions.
- `data/questions.json` — the live question bank (created on first boot, editable by the host).
- `test/` — grid, game and socket integration tests.

## Quick start (local Wi-Fi)

```bash
npm install
HOST_PIN=123456 npm start
```

The server prints the LAN URLs and a 5-character join code, for example:

```
Display   http://192.168.1.69:4321/display
Presenter http://192.168.1.69:4321/host
Join      http://192.168.1.69:4321/play   (code DBEY4)
PIN       123456
```

1. Open the **Presenter** URL on the facilitator laptop.
2. Unlock with the PIN printed in the terminal.
3. Open the **Display** URL on the projector (full screen).
4. Players scan the QR code or open the **Join** URL and enter the code.
5. Configure the game in the Setup/Lobby tabs, then press **START OPERATION**.

If no `HOST_PIN` is set, a random 6-digit PIN is generated and printed. Set it
explicitly for repeatable sessions.

### Firewall note

Phones must reach the laptop on the chosen port. On macOS allow Node through the
firewall when prompted; on Windows allow it through Windows Defender Firewall.
If players cannot connect, check that the laptop and phones are on the same Wi-Fi
and that no guest isolation is enabled on the router.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `HOST_PIN` | random 6 digits | Presenter PIN. |
| `PUBLIC_URL` | auto | Public base URL (overrides LAN detection). Use for Railway or a reverse proxy. |
| `DATA_DIR` | `./data` | Where `questions.json`, backups and `game-state.json` are stored. |
| `NODE_ENV` | — | Set to `production` on hosts. |

Railway sets `PORT` and `RAILWAY_PUBLIC_DOMAIN` automatically.

## Railway deployment

1. Push the repository to GitHub.
2. Create a new Railway project from the repo.
3. Add a **Volume** mounted at `/data` and set `DATA_DIR=/data`.
4. Set `HOST_PIN` to a strong value.
5. Optionally set `PUBLIC_URL=https://your-app.up.railway.app`.
6. Deploy. The start command is `npm start` (see `railway.json`).

The volume keeps questions, backups and the game snapshot across restarts. Host
tokens are restored from the snapshot, so a redeploy does not log the presenter out.

## Playing a game

- **Modes**: teams (pooled missiles and score) or individual (one fleet slot per player).
- **Grids**: 1 (shared hostile target) or 2/3 (one fleet per team/player).
- **Question flow**: briefing → solution → combat. In manual mode the presenter
  reveals the solution and opens combat; in auto mode everything is timed.
- **Missiles**: awarded for correct answers (first correct, or all correct). Fire
  during the combat phase only.
- **Winning**: last fleet standing, or the shared target destroyed.

The projector hides unsunk ships; the presenter can reveal them with the
**Reveal ships** setting.

## Presenter console

Tabs:

- **Setup** — structure (grid count, mode, capacity) locked once players join;
  live rules (awards, attempts, missile cap, timers, question mode).
- **Lobby** — QR code, join link, teams, roster, fleet cards, manual/random
  placement, start checks.
- **Control** — start/pause/reveal/open combat/next/end/restart/new game,
  answer monitor, team telemetry, manual missile grants, attack feed, final
  ranking.
- **Questions** — search/filter, create/edit/delete, import/export JSON.

Ship placement: click **PLACE** on a fleet, drag over the grid to preview, click to
place, rotate with the button, clear or randomise, then **APPLY PLACEMENT**.

## Question bank

Questions live in `data/questions.json`. The host editor writes back with a
timestamped backup in `data/backups/`. Import/export uses the same JSON shape:

```json
{ "version": 1, "updated": "...", "questions": [ { "id", "topic", "difficulty",
  "question", "options": [4], "correctIndex", "explanation" } ] }
```

## Tests

```bash
npm test
```

26 tests covering grid placement/firing, game state machine, sockets, snapshots
and projections.

## Troubleshooting

- **Players cannot join**: check firewall and same-network. Use `PUBLIC_URL` if
  hosting behind a proxy.
- **Lost presenter session after restart**: set `HOST_PIN` and keep `DATA_DIR` on a
  persistent volume.
- **Audio not playing**: browsers require a user gesture; click anywhere once.
  The benign `AudioContext` device message is harmless.
- **Structure locked**: grid count and mode can only change with an empty lobby.
