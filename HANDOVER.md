# Handover / Changelog — CYBER BATTLESHIPS

Build location: `/Users/neil/Documents/Code Stuff - Open Code/Battleships`
Runtime: Node >= 20, deps installed (`express`, `socket.io`, `qrcode`, `socket.io-client`).

## Status

Feature-complete and smoke-tested. `npm test` passes 26/26. The presenter,
projector and phone clients have been exercised end-to-end in a browser against
a live server (lobby, join, start, answer, reveal, combat, fire, next, end,
rematch, new game, 1-grid and 3-grid/individual flows, question editor,
placement modal, pause, reconnect).

## What was built

- `server/` — authoritative game state machine, grid engine, role-scoped
  projections, question store, persistence snapshots, config/network, socket
  layer, host auth + rate limits.
- `public/` — presenter console, projector display, phone controller, shared
  design system and WebAudio engine.
- `server/questions.seed.json` — 30 cyber-security questions across 11 topics.
- `README.md` — local and Railway launch instructions.

## Key behaviour

- One active game per server; `newGame()` rotates the 5-char join code and
  keeps host tokens.
- Firing is restricted to the `battle` phase only (`Game.fire` and
  `projection.canFire`).
- Teams pool missiles/score; individual mode creates one fleet slot per player.
- 1-grid mode uses a shared hostile target; 2/3-grid modes give each team/player
  its own fleet.
- Host projection exposes ship cells and the answer key; display and phones do not.
- `DATA_DIR` supports a Railway volume; debounced JSON snapshot restores on boot.

## Bugs found and fixed during verification

1. **Placement modal stuck on "APPLYING…"** — `host:setShips` now acknowledges
   the client (`reply({ok:true})`); the modal closes on ack instead of waiting
   for a matching state broadcast. State-driven matching kept as a fallback.
2. **Question editor "edit" created duplicates** — `QuestionStore.upsert` removed
   the edited id from its uniqueness set before normalising, so an edit keeps
   its id instead of generating a new one.
3. **Display never showed hits** — `FxLayer.loop` never rescheduled itself via
   `requestAnimationFrame`, so projectiles never reached `onImpact` and the
   pending snapshot never cleared. Fixed; plus a hidden-tab guard and a
   1.4 s self-heal in `updateBattle` so a backgrounded projector cannot lag.
4. **Phone reconnect dropped the controller** — `play.js` now retries
   `player:resume` until `player:ok`/`player:gone` and no longer flips to the
   join screen on a transient state without `me`.
5. **Stale URL join code after a new game** — URL-prefilled join codes are marked
   `autofilled`, so they track the current game code.
6. **Display signature collisions** — question/reveal signatures include the
   question number; final signature includes `endedAt`.
7. **Generated host PIN** raised from 4 to 6 digits; placeholder updated.
8. **Mobile/desktop audio** — only the benign `AudioContext` device message
   remains.

## Remaining / not yet verified

- Import/export of the question bank through the file picker (store-level
  replace is unit-tested; UI path uses a standard `<input type="file">`).
- Mobile viewport layout and touch ergonomics on a real phone.
- External-network / console audit beyond the smoke test.
- Railway deploy (no live environment available here).

## Housekeeping

- `data/` contains `questions.json` (30 questions), `game-state.json` and
  backups from local testing. For a clean release, delete `data/` (or point
  `DATA_DIR` at an empty folder) so the server reseeds from
  `server/questions.seed.json`.
- Remove any `console.log`/debug lines before release (none remain).
- `npm test` is the regression gate.
