# Cyber Battleships

A live cyber-security quiz game for a room. One big screen runs the game; players
join on their phones by scanning a QR code. Answer questions to earn missiles,
then fire them at the other fleet.

There is no facilitator dashboard. The big screen **is** the control surface.

## How a game runs

1. **Lobby.** The big screen shows a QR code, a six-character join code and the
   sides. Players scan, type a name and pick a side. The facilitator can open
   **SETTINGS** and press **START GAME**.
2. **Quiz.** A 1, 2 or 3 minute timer runs. Every phone gets its own stream of
   questions, one after another, at its own pace. Each question has **three
   answers**. Each correct answer earns the team **1 missile** and 10 points. The
   big screen shows live progress for every side and player. **SKIP TIMER** ends
   it early.
3. **Briefing.** The big screen shows what each side won: missiles, correct
   answers, accuracy and top player. The facilitator presses **START BATTLE**.
4. **Battle.** Players tap a square on their phone to fire. Hits score 25 points
   and sinking a ship adds 50. The player list sits on the left of the screen so
   the boards stay clear.
5. **Out of missiles.** When the missiles run out (or the battle timer ends) the
   screen prompts for **MORE QUESTIONS**. Another question round starts, and the
   fleets, shots, scores and any unspent missiles carry over. If missiles are
   left over, **RESUME BATTLE** goes straight back to firing.
6. **Result.** The game ends **when every ship on a fleet is sunk**. The result
   shows the winner, scores and the revealed fleets. **END GAME** ends it early
   and decides the winner on score. **PLAY AGAIN** keeps the same players,
   **BACK TO LOBBY** reopens the room, and **NEW GAME** makes a fresh join code.

### Game modes

| Mode | Sides | Notes |
| --- | --- | --- |
| **3 vs 3** | ALPHA and BRAVO, 3 players each | Teammates share one missile pool |
| **Team vs team** | ALPHA and BRAVO, up to 20 players each | Two teams head to head. Every **3 correct answers** earn the team one missile. A captain fires for each team, chosen again every question round |
| **Everyone vs CPU** | One crew of up to 20 | All players attack the CPU fleet |
| **3 teams** | ALPHA, BRAVO and CHARLIE, up to 20 players each | Every **3 correct answers** earn the team one missile. Each team may attack either other fleet; the captain picks one with tabs on their phone. A team with every ship sunk is out, and the last fleet afloat wins |

On the big screen every board is tinted in the colour of the fleet under attack,
and each shot is coloured by the team that fired it.

## Quick start

```bash
npm install
npm run dev
```

Open the Vite URL (usually <http://localhost:5173>) and go to `/display`.
For a single production-style process:

```bash
npm run build
npm start
```

| Page | URL | Who uses it |
| --- | --- | --- |
| Game screen | `/display` | The room's big screen (facilitator) |
| Players | `/<CODE>` or `/play?code=<CODE>` | Phones, reached by the QR code |
| Welcome | `/` | Facilitator start page (START GAME opens `/display`); players can type a join code here |

## Facilitator guide

Open `/` on the room screen and press **START GAME**. It opens `/display`, creates a game and shows
the QR code. That browser remembers the game, so a refresh keeps control.

- **SETTINGS** (lobby only): game mode, quiz time (1–3 min), battle time
  (30–180 s), grid size, question set, sound, and question import/export.
- **During a game** the bottom bar changes with the phase: **SKIP TIMER**,
  **START BATTLE**, **END BATTLE ROUND**, **MORE QUESTIONS**, **RESUME BATTLE**,
  **END GAME**, **PLAY AGAIN**, **BACK TO LOBBY**. Buttons that end or reset the
  game ask you to tap twice.
- **Removing a player:** tap the ✕ next to a name in the lobby, then tap again to
  confirm.
- **Second screen:** opening `/display` on another device shows a **view only**
  mirror. It cannot change the game.
- **Lost control** (cleared browser, different laptop): open `/display?new` or
  press **TAKE CONTROL** on the mirror. This ends the current game and starts a
  fresh one.

### Control without a PIN

When a game is created, the screen that created it receives a random control key
and stores it in its own browser. Starting, skipping, settings, removing players
and the question import/export all require that key. Phones never receive it, so
players cannot start or end the game even by sending messages directly.

## Logo and sounds

- The ship logo lives in `client/public/brand/`. `mark-*.png` are transparent
  versions used inside the game; `logo-64.png` and `logo-180.png` are the browser
  tab and home-screen icons. The original artwork is `CBlogo.png` in the project
  root (not committed).
- Battle sounds live in `client/public/sounds/`: `fire1-5`, `hit1-3`, `miss1-3`
  and `sink1-3`. Every shot plays a random fire sound, then a hit, miss or sink
  sound. Each group is shuffled so the same clip is not heard twice in a row.
  Long clips fade out (fire after 3.5 s, hits 4 s, misses 3 s, sinks 7 s).
- The big screen plays a sound for every shot in the room; each phone plays its
  own shots. The **Sound effects** setting and the **SND** button turn them off.
- To swap a sound, replace the file with one of the same name and redeploy.

## Editing the questions

There are two question sets, **Easy** and **Complex**, stored in the database.
The game uses whichever is selected in Settings.

1. Open **SETTINGS** in the lobby.
2. Under **Question set**, press **EXPORT CSV** on the set you want to change.
3. Edit the file in Excel or Google Sheets.
4. Press **IMPORT CSV** and choose the file.
5. Check the preview and press **CONFIRM IMPORT**.

The file has one row per question:

```
category,question,option_a,option_b,option_c,correct,explanation
Passwords,Which is strongest?,password1,Tr0ub4dor,a long random passphrase,C,Length beats cleverness
```

- Every question has **three answers**. `correct` is `A`, `B` or `C`. `category`
  and `explanation` may be blank.
- An older four-answer file still imports: the `option_d` column is ignored (with a
  note), and any row whose `correct` is `D` is reported as a problem.
- A set needs at least 8 and at most 500 questions.
- Commas, semicolons and tabs are all accepted as separators, so files saved by
  Excel in other regions work.
- Import is all-or-nothing. If any row has a problem, the screen lists each one by
  row number and **nothing is changed**.
- **RESET** (shown once a set has been edited) restores the built-in questions.
- Imports and resets are only allowed in the lobby.
- Edited sets are stored in PostgreSQL. A redeploy never overwrites them.
- Answer positions are shuffled for every player, so the right answer is not
  always in the same slot.
- Question sets saved earlier with four answers are tidied automatically when the
  server starts: the built-in sets are restored, and edited sets keep every
  question with the correct answer plus two wrong ones.

If Excel shows everything in one column, use **Data → From Text/CSV** and choose
UTF-8.

## Tests

```bash
npm test
```

The suite covers the game engine (modes, scoring, timers, repeated question and
battle rounds, three-answer questions, late answers, projections never leaking
answers or fleets), the question CSV parser
and store, the protected import/export routes, and real Socket.IO games from
lobby to result, including restart recovery.

## Configuration

Copy `.env.example` to `.env` if you need to change anything. No cookie secret is
needed.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_URL` | Railway domain / LAN | Base URL used in QR codes and join links |
| `FACILITATOR_PIN` | `rocu` | PIN to start or replace a game; empty turns it off |
| `BATTLE_INTRO_MS` | `11000` | Delay before the first battle opens while the intro plays; `0` removes it |
| `DATABASE_URL` | empty | PostgreSQL URL; empty uses embedded PGlite |
| `PGSSL` | on in production | Set `false` for a local Postgres without TLS |
| `DATA_DIR` | `./data` | PGlite data directory |
| `SESSION_RETENTION_HOURS` | `24` | A game expires after this long |
| `ALLOWED_ORIGINS` | empty | Extra Socket.IO origins, comma separated |

## Deploy to Railway

1. Create a Railway project and add the **PostgreSQL** plugin.
2. Deploy this repository. `railway.json` builds the client and starts
   `npm start`; the health check is `/healthz`.
3. Optionally set `PUBLIC_URL`. Railway provides `DATABASE_URL`, and the public
   domain is used for QR codes automatically.
4. Open `https://<your-domain>/display` on the room screen.

The game and the question sets live in PostgreSQL, so a redeploy keeps an active
game and its players, and phones reconnect on their own. Old `ADMIN_PIN` and
`COOKIE_SECRET` variables are no longer used and can be deleted. Set
`FACILITATOR_PIN` in Railway so the PIN is not just the default in the source.

## Run with Docker

```bash
docker compose up --build
```

This starts PostgreSQL 16 and the app on <http://localhost:3000>.

## Project layout

```
client/
  index.html, display.html, play.html
  src/{landing,display,play}/main.js
  src/shared/            # api, socket, audio, clock, dom, grid helpers
  styles/                # theme.css plus one stylesheet per page
server/
  app.js                 # Express routes, QR, question import/export
  realtime/socket.js     # sockets, control key, reconnect handling
  sessions/session.js    # the game state machine
  sessions/round.js      # fleets, sides and targets
  sessions/manager.js    # the single live game, restore, timers
  sessions/projections.js# what each screen is allowed to see
  questions/             # CSV parser and the database-backed store
  db/                    # PGlite/Postgres adapter, migrations, repository
shared/                  # constants, events, schemas, built-in questions
test/                    # node:test unit and integration suites
docs/architecture.md     # design notes
```

## Troubleshooting

- **"Client bundle not built"**: run `npm run build` before `npm start`, or use
  `npm run dev`.
- **Phones cannot open the QR link**: they need to reach the server. On a local
  network use the LAN address printed at startup, or set `PUBLIC_URL`.
- **The screen says VIEW ONLY**: it did not start this game. Use the original
  screen, or press **TAKE CONTROL** to start over.
- **Postgres TLS errors locally**: set `PGSSL=false`.

## Captains and bonus missiles

- Everyone on a side answers questions and earns missiles for the shared pool, but
  only one player per side, the **captain**, fires them. The rest watch the
  captain's shots on their phones. A captain is picked at random at the start of
  every question round, and a different player is chosen each time, so everyone
  gets a turn before anyone repeats. If the captain goes offline during a battle,
  a teammate takes over.
- **Controls swap every 30 seconds.** During a battle the controls pass to a random,
  different, connected teammate every 30 seconds. The new captain gets a green
  "you have the controls" pop-up and the old one an amber "controls passed" pop-up.
  A captain can also press **PASS CONTROLS TO A TEAMMATE** at any time. A side with
  only one player online keeps its captain.
- When questions start, a short 5 second animation on the big screen and the phones
  shows each side's captain being drawn.
- Three correct answers in a row earn a bonus missile, and so do the fourth and
  fifth. The bonus is shown on the player's phone. From the sixth in a row, and
  after any wrong answer, there is no further bonus until a new streak of three.
  Streaks start again with each question round.

## Joining and playing from a laptop

- Players can join during the lobby **and during a question round**; a late joiner
  gets a question straight away. Joining closes during the battle and reopens
  with the next question round. The **JOIN** button in the top banner shows the QR
  code, join code and link during a question round.
- Players can also join by going to the site's address and typing the six-character
  code on the welcome page, or by typing the short link shown on the big screen.
- On a laptop or Chromebook, answer with **1 / 2 / 3** or **A / B / C**, or click.
  The captain fires by clicking a square with the mouse or trackpad.

## Cut scenes and keyboard control

- **F** toggles full screen and **S** toggles the sound on the big screen (the FS and SND
  buttons do the same).

- **Cut scenes** play on the big screen only, fading up from black over analogue
  interference (static, scan lines, a rolling band) with bold text and the battle
  music (the videos themselves are muted): an **intro** before the first battle
  ("BATTLE"), **regroup** when a battle round ends ("REGROUP – collect more
  questions for more missiles"), and **end** when the game is over ("GAME OVER – ALPHA
  WON"), with a few random hit sounds and each team's current captain along the bottom. Videos live in `client/public/video/`.
  Firing opens when the intro finishes (`BATTLE_INTRO_MS`, default 11000; the full
  battle time still follows). Any key or a click skips a scene.
- **Space, Page Down, Right Arrow** (and Enter) press the big main button, so the
  game can be run from the keyboard or a presentation clicker: START GAME,
  START BATTLE, MORE QUESTIONS, PLAY AGAIN. Where that would stop a running timer
  (SKIP TIMER, END BATTLE ROUND) or start an empty game, press twice within 2.5
  seconds.

## Question vault

Under **SETTINGS → QUESTION SET**, the **VAULT** card opens a pop-up listing saved
question lists. **IMPORT A NEW LIST** takes a name and a CSV file in the same format
as the built-in sets, previews it, saves it to the database and selects it for the
game. Saved lists can be picked again for later games, exported or deleted (lobby
only, up to 50 lists). Easy and Complex cannot be deleted.

## Facilitator PIN

Starting a game, or replacing a running one, asks for a facilitator PIN, so a stranger
who opens `/display` cannot take over the room. The screen that started a game keeps
control without the PIN. Five wrong tries lock that address for a minute. Set the PIN
with the `FACILITATOR_PIN` variable (the default is `rocu`; set it to an empty value to
turn the PIN off). Players are never asked for it.

## Background music

The facilitator screens loop music from `client/public/music/`: `welcome-menu.mp3` on the welcome page, lobby and results, `questionround.mp3` during quiz, briefing and resupply, and `battle.mp3` during battle. Phones stay silent. It follows the SND button and the sound setting, and browsers only start it after the first click or key press.
