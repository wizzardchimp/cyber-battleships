# Cyber Battleships: Architecture

One server runs one live game. A big screen controls it, and phones play it. The
server is the only authority: clients send intents and render the state they are
sent.

```
Browsers                          Node.js server                     PostgreSQL
┌──────────────────┐   HTTP/WS   ┌───────────────────────────┐      ┌──────────────┐
│ /display (screen)│◀──────────▶│ Express (QR, CSV routes)   │      │ sessions     │
│ /play    (phones)│            │ Socket.IO gateway          │◀────▶│ teams        │
└──────────────────┘            │ SessionManager (one game)  │      │ players      │
                                │ GameSession (state machine)│      │ question_sets│
                                │ Projections (safe views)   │      │ events       │
                                └───────────────────────────┘      └──────────────┘
```

## Phases

```
lobby ─start─▶ quiz ─timer/skip─▶ review ─start battle─▶ battle ──fleet sunk──▶ result
  ▲              ▲                                          │                     │
  │              └──── more questions ◀── resupply ◀────────┘ timer / no missiles │
  └──────────────────── back to lobby / play again ◀──────────────────────────────┘
```

| Phase | Ends when |
| --- | --- |
| `lobby` | Facilitator starts (any number of players) |
| `quiz` | The quiz timer runs out, or the facilitator skips |
| `review` | The facilitator starts the battle (or ends the game) |
| `battle` | A fleet is destroyed (`result`), or the timer ends / nobody has missiles after 3 s / the facilitator ends the round (`resupply`) |
| `resupply` | **More questions** starts another quiz round; **resume** returns to battle if missiles remain; **end game** goes to `result` |
| `result` | Play again (new game), back to lobby, or a new game |

Each trip through `quiz → review → battle` is a *question round* (`round.cycle`).
The game itself (`round.number`) only ends when every ship on a fleet is sunk, or
the facilitator ends it on score. Between question rounds the fleets, shots,
scores and unspent missiles carry over; per-round answer counters and each
player's question numbering restart, and a player does not see a repeat question
until their set is used up.

## Modes

Modes are presets that define the sides and their size.

| Mode | Sides | Targets |
| --- | --- | --- |
| `squad` (3 v 3) | ALPHA, BRAVO × 3 | Each side attacks the other |
| `duel` (1 v 1) | ALPHA, BRAVO × 1 | Each side attacks the other |
| `cpu` | CREW × 20 | The crew attacks the CPU fleet |
| `fleet` (3 teams) | ALPHA, BRAVO, CHARLIE × 20 | Each side may attack either other side (`targetIds`); a captain passes `targetId` with each shot |

In `fleet` mode a side earns one missile per `correctPerMissile` (3) correct answers;
the remainder is kept in `state.ammoProgress[teamId]`. A side whose fleet is fully
sunk is eliminated (`team.eliminated`); the game ends when one fleet is left.

During a battle `rotateCaptains` runs from the tick every `TIMING.captainSwapMs`
(30 s, `round.captainSwapAt`). A captain may also call `passCaptain`.

The question vault stores extra sets in `question_sets` under ids `vault-<hex>`,
managed by `POST /api/vault` and `DELETE /api/vault/:id` (control key, lobby only).

Starting or replacing a game needs the facilitator PIN (`config.facilitatorPin`)
unless the socket holds the control key; wrong PINs are rate limited per address.

Changing mode in the lobby rebuilds the sides and re-seats players, keeping each
on their side where possible. The change is refused if more players are present
than the new mode holds.

## Quiz engine

- Questions are **self-paced**. Each player has their own stream stored in
  `round.quiz[playerId]`: a counter, the questions already seen, and the current
  question (with its answer key, server-side only).
- A player never sees a repeat until their whole set has been used, then it
  recycles.
- Options are shuffled when a question is issued, so the answer slot varies.
- An answer is accepted until the quiz timer ends plus a 1.5 s grace period.
  The reply carries the correct index and explanation; the next question is
  issued immediately.
- Every question has exactly three answers: the correct one plus two wrong ones,
  shuffled. Older data with more answers is trimmed when it is served and tidied
  in the database on startup.
- A correct answer gives the side 1 missile and 10 points. Teams share one pool.

## Battle engine

- Each side owns a fleet of five ships on a square grid, regenerated every round.
- A shot costs one missile, can only target the opposing grid, and each cell can
  be hit once. A hit scores 25, a sunk ship adds 50.
- A destroyed fleet wins at once. Running out of missiles or time never ends the
  game; it pauses into `resupply` so the sides can earn more.
- If the facilitator ends the game early the higher score wins, then more hits,
  otherwise it is a draw. Versus CPU, the crew wins only by sinking the whole
  firewall.

## What each screen may see

Projections are built field by field, never by spreading the stored state.

| View | Sees | Never sees |
| --- | --- | --- |
| Game screen / mirror | Rosters, progress, scores, shots, ships **after** the result | Questions, answers, ships during battle, tokens, the control key |
| Phone | Public view, its own current question (no answer), its target's shots | Other players' questions, ship positions during battle |

The game screen also receives `viewer.control = true` when its socket proved it
holds the control key.

## Control without a PIN

1. `display:create` makes the game and returns a random control key **once**. Only
   its SHA-256 hash is stored.
2. The screen keeps the key in `localStorage` and sends it with
   `display:subscribe`. If it matches, the socket is marked as controlling.
3. Control events (`advance`, `lobby`, `settings`, `remove`) and the HTTP
   question routes require that proof.
4. A second screen without the key is a read-only mirror. It can only start a new
   game when none exists, or by explicitly taking over (`force`), which ends the
   current game.

## Socket events

| Event | From | Effect |
| --- | --- | --- |
| `display:subscribe` | screen | Attach to the game; reports whether it controls |
| `display:create` | screen | Create a game (replaces the current one with the key or `force`) |
| `display:advance` | controller | Start, skip, start battle, end the battle round, more questions, or play again, depending on the phase |
| `display:resume` | controller | Resume firing after a pause, while missiles remain |
| `display:finish` | controller | End the game now and decide the winner on score |
| `display:lobby` | controller | Return to the lobby |
| `display:settings` | controller | Change settings (lobby only) |
| `display:remove` | controller | Remove a player |
| `player:join` / `player:resume` | phone | Enlist or reattach with a saved token |
| `player:chooseTeam` | phone | Switch sides in the lobby |
| `player:answer` | phone | Answer the current question |
| `player:attack` | phone | Fire one missile |

All handlers validate with Zod, are rate limited per socket, and acknowledge with
`{ ok: true }` or `{ ok: false, error: { code, message } }`.

## Question sets

- Table `question_sets (id, name, questions jsonb, is_custom, updated_at)`.
- On boot, a default set is written **only if it is missing**, so edits survive
  redeploys. Sets are cached in memory.
- Routes (all but the list need the `x-control-key` header):
  - `GET /api/questions` lists sets with counts
  - `GET /api/questions/:set/export.csv` downloads a UTF-8 CSV with a BOM (three answer columns)
  - `POST /api/questions/:set/import` validates (`dryRun`) or replaces a set
  - `POST /api/questions/:set/reset` restores the built-in questions
- Import and reset only work in the lobby. The parser detects comma, semicolon or
  tab delimiters, reports problems by spreadsheet row, and refuses the whole file
  if any row is invalid.

## Persistence and restart

- The full game state is a JSONB snapshot in `sessions`, with normalised team and
  player rows and an append-only event log.
- Saves coalesce: if one is already queued it saves the latest state when it runs.
- On boot the manager restores the newest game of the current schema version and
  deletes anything older. Players are marked offline until their phones resume;
  timers carry on from the stored deadlines.
- Phones reconnect with a stored token. A second device using the same token
  supersedes the first. A player who stays offline for 8 seconds is marked offline.

## Screens and rendering

- Both clients re-render from each state update, but skip the work when what the
  user can see has not changed. This stops a tap being lost when another player's
  answer triggers a broadcast.
- The big screen keeps its controls, settings dialog and file picker outside the
  re-rendered area for the same reason.
- Countdowns are driven by server deadlines, with a clock offset from the server.
