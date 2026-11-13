import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PHASES } from '../shared/constants.js';
import { EVENTS } from '../shared/events.js';
import {
  bootTestServer,
  collectStates,
  connect,
  emitAck,
  joinPlayer,
  startGameScreen,
  waitFor,
} from './helpers.js';

function closeAll(sockets) {
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
}

function latestPhase(collector, phase) {
  const state = collector.latest();
  return state?.session?.phase === phase ? state : null;
}

test('the game screen creates one game and phones join it by code', async (t) => {
  const h = await bootTestServer();
  const sockets = [];
  t.after(async () => {
    closeAll(sockets);
    await h.close();
  });

  const screen = await startGameScreen(h.baseUrl, EVENTS);
  sockets.push(screen.socket);
  const code = screen.game.joinCode;
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.ok(screen.key.length >= 20);

  const lobby = await waitFor(() => latestPhase(screen.states, PHASES.LOBBY), {
    label: 'game screen lobby',
  });
  assert.equal(lobby.viewer.control, true);
  assert.equal(lobby.session.mode, 'squad');
  assert.equal(lobby.join.url, `${h.config.publicUrl}/${code}`);

  const summary = await fetch(`${h.baseUrl}/api/sessions/${code}`).then((response) => response.json());
  assert.equal(summary.counts.players, 0);
  assert.equal(summary.teams.length, 2);
  assert.ok(!JSON.stringify(summary).includes('controlKey'));

  const qr = await fetch(`${h.baseUrl}/api/sessions/${code}/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  const short = await fetch(`${h.baseUrl}/${code}`, { redirect: 'manual' });
  assert.equal(short.status, 302);
  assert.equal(short.headers.get('location'), `/play?code=${code}`);
  const unknown = await fetch(`${h.baseUrl}/ZZZZZZ`, { redirect: 'manual' });
  assert.notEqual(unknown.status, 302);

  const players = [];
  for (const name of ['Nova', 'Vector', 'Echo', 'Pixel']) {
    const player = await joinPlayer(h.baseUrl, EVENTS, code, name);
    assert.equal(player.result.ok, true, JSON.stringify(player.result));
    sockets.push(player.socket);
    players.push(player);
  }

  const full = await waitFor(
    () => {
      const state = screen.states.latest();
      return state?.counts?.players === 4 && state.counts.connected === 4 ? state : null;
    },
    { label: 'four players on the game screen' },
  );
  assert.deepEqual(full.teams.map((team) => team.playerCount), [2, 2]);

  const mine = await waitFor(() => players[0].states.latest()?.me?.name === 'Nova' && players[0].states.latest(), {
    label: 'player projection',
  });
  assert.ok(mine.me.teamName);
  assert.ok(!JSON.stringify(mine).includes('tokenHash'));
});

test('only the game screen holding the key can control the game', async (t) => {
  const h = await bootTestServer();
  const sockets = [];
  t.after(async () => {
    closeAll(sockets);
    await h.close();
  });

  const screen = await startGameScreen(h.baseUrl, EVENTS);
  sockets.push(screen.socket);
  const code = screen.game.joinCode;
  const player = await joinPlayer(h.baseUrl, EVENTS, code, 'Curious');
  sockets.push(player.socket);

  // A player cannot start the game or change settings.
  const playerStart = await emitAck(player.socket, EVENTS.DISPLAY_ADVANCE, {});
  assert.equal(playerStart.ok, false);
  assert.equal(playerStart.error.code, 'UNAUTHORIZED');
  const playerSettings = await emitAck(player.socket, EVENTS.DISPLAY_SETTINGS, { patch: { quizMinutes: 1 } });
  assert.equal(playerSettings.ok, false);

  // A second screen without the key sees the game but cannot control it.
  const mirror = await connect(h.baseUrl);
  sockets.push(mirror);
  const mirrorStates = collectStates(mirror);
  const mirrorSub = await emitAck(mirror, EVENTS.DISPLAY_SUBSCRIBE, {});
  assert.equal(mirrorSub.ok, true);
  assert.equal(mirrorSub.control, false);
  assert.equal(mirrorSub.game.joinCode, code);
  const mirrored = await waitFor(() => mirrorStates.latest(), { label: 'mirror state' });
  assert.equal(mirrored.viewer.control, false);
  const mirrorStart = await emitAck(mirror, EVENTS.DISPLAY_ADVANCE, {});
  assert.equal(mirrorStart.ok, false);

  // A wrong key is no better than no key.
  const wrong = await connect(h.baseUrl);
  sockets.push(wrong);
  const wrongSub = await emitAck(wrong, EVENTS.DISPLAY_SUBSCRIBE, { key: 'x'.repeat(24) });
  assert.equal(wrongSub.control, false);
  const wrongStart = await emitAck(wrong, EVENTS.DISPLAY_ADVANCE, {});
  assert.equal(wrongStart.ok, false);

  // A new game cannot be created over the live one without the key.
  const intruder = await connect(h.baseUrl);
  sockets.push(intruder);
  const hijack = await emitAck(intruder, EVENTS.DISPLAY_CREATE, {});
  assert.equal(hijack.ok, false);
  assert.equal(hijack.error.code, 'GAME_EXISTS');
  assert.equal(h.manager.current().joinCode, code);

  // The real screen can resume with its key after a reload.
  const reloaded = await connect(h.baseUrl);
  sockets.push(reloaded);
  const reloadSub = await emitAck(reloaded, EVENTS.DISPLAY_SUBSCRIBE, { key: screen.key });
  assert.equal(reloadSub.control, true);
  assert.equal((await emitAck(reloaded, EVENTS.DISPLAY_ADVANCE, {})).ok, true);
  await waitFor(() => player.states.latest()?.session?.phase === PHASES.QUIZ, {
    label: 'player enters the quiz',
  });
});

test('a full game: quiz, briefing, battle and result over real sockets', async (t) => {
  const h = await bootTestServer();
  const sockets = [];
  t.after(async () => {
    closeAll(sockets);
    await h.close();
  });

  const screen = await startGameScreen(h.baseUrl, EVENTS);
  sockets.push(screen.socket);
  const code = screen.game.joinCode;
  const ready = await emitAck(screen.socket, EVENTS.DISPLAY_SETTINGS, {
    patch: { mode: 'duel', quizMinutes: 1, battleSeconds: 30 },
  });
  assert.equal(ready.ok, true, JSON.stringify(ready));

  const alpha = await joinPlayer(h.baseUrl, EVENTS, code, 'Alpha One');
  const bravo = await joinPlayer(h.baseUrl, EVENTS, code, 'Bravo One');
  sockets.push(alpha.socket, bravo.socket);
  const sides = [alpha, bravo];

  await waitFor(() => screen.states.latest()?.counts?.players === 2, { label: 'two players' });
  assert.equal((await emitAck(screen.socket, EVENTS.DISPLAY_ADVANCE, {})).ok, true);

  const quiz = [];
  for (const side of sides) {
    quiz.push(
      await waitFor(
        () => {
          const state = side.states.latest();
          return state?.session?.phase === PHASES.QUIZ && state.round?.me?.question ? state : null;
        },
        { label: 'player question' },
      ),
    );
  }
  assert.equal(quiz[0].round.me.question.options.length, 3);
  assert.ok(!JSON.stringify(quiz[0]).includes('answerIndex'));

  // The projector shows progress but never a question or an answer key.
  const projector = await waitFor(() => latestPhase(screen.states, PHASES.QUIZ), { label: 'projector quiz' });
  assert.ok(projector.round.quizEndsAt);
  assert.equal(projector.round.teams.length, 2);
  assert.ok(!JSON.stringify(projector).includes('prompt'));
  assert.ok(!JSON.stringify(projector).includes('answerIndex'));

  // Alpha answers correctly using the server-side key; Bravo answers wrongly.
  const session = h.manager.current();
  const alphaPlayerId = alpha.result.playerId;
  const current = session.state.round.quiz[alphaPlayerId].current;
  const right = await emitAck(alpha.socket, EVENTS.PLAYER_ANSWER, {
    questionNumber: current.number,
    optionIndex: current.answerIndex,
  });
  assert.equal(right.ok, true, JSON.stringify(right));
  assert.equal(right.correct, true);
  assert.equal(right.missiles, 1);
  assert.equal(right.correctIndex, current.answerIndex);

  const bravoCurrent = session.state.round.quiz[bravo.result.playerId].current;
  const wrong = await emitAck(bravo.socket, EVENTS.PLAYER_ANSWER, {
    questionNumber: bravoCurrent.number,
    optionIndex: (bravoCurrent.answerIndex + 1) % 3,
  });
  assert.equal(wrong.correct, false);

  const next = await waitFor(
    () => {
      const state = alpha.states.latest();
      return state?.round?.me?.question?.number === 2 ? state : null;
    },
    { label: 'next question arrives straight away' },
  );
  assert.equal(next.round.me.correct, 1);

  // Skip the timer: the briefing summarises each side.
  assert.equal((await emitAck(screen.socket, EVENTS.DISPLAY_ADVANCE, {})).ok, true);
  const briefing = await waitFor(() => latestPhase(screen.states, PHASES.REVIEW), { label: 'briefing' });
  const alphaRow = briefing.round.teams.find((team) => team.name === 'ALPHA');
  assert.equal(alphaRow.correct, 1);
  assert.equal(alphaRow.missiles, 1);

  assert.equal((await emitAck(screen.socket, EVENTS.DISPLAY_ADVANCE, {})).ok, true);
  const battle = await waitFor(
    () => {
      const state = alpha.states.latest();
      return state?.session?.phase === PHASES.BATTLE && state.round?.me?.targetBoard ? state : null;
    },
    { label: 'player battle' },
  );
  assert.equal(battle.round.me.missiles, 1);
  assert.ok(battle.round.me.targetBoard.ships === undefined, 'no ship positions during battle');

  const targetFleet = session.state.fleets[battle.round.me.targetId];
  const cell = targetFleet.ships[0].cells[0];
  const shot = await emitAck(alpha.socket, EVENTS.PLAYER_ATTACK, { x: cell.x, y: cell.y });
  assert.equal(shot.ok, true, JSON.stringify(shot));
  assert.equal(shot.hit, true);
  const noAmmo = await emitAck(alpha.socket, EVENTS.PLAYER_ATTACK, { x: 0, y: 0 });
  assert.equal(noAmmo.ok, false);
  assert.equal(noAmmo.error.code, 'NO_MISSILES');

  // The facilitator ends this battle round. Nobody has won, so the game offers
  // another round of questions to earn more missiles.
  assert.equal((await emitAck(screen.socket, EVENTS.DISPLAY_ADVANCE, {})).ok, true);
  const paused = await waitFor(() => latestPhase(screen.states, PHASES.RESUPPLY), { label: 'resupply' });
  assert.equal(paused.round.battleEndReason, 'ended');
  assert.equal(paused.round.outcome, null);
  assert.ok(paused.round.boards.every((board) => board.ships === undefined), 'ships still hidden');
  const pausedPhone = await waitFor(() => latestPhase(alpha.states, PHASES.RESUPPLY), { label: 'phone resupply' });
  assert.equal(pausedPhone.round.me.missiles, 0);

  // Another question round: same fleets and shots, fresh questions.
  assert.equal((await emitAck(screen.socket, EVENTS.DISPLAY_ADVANCE, {})).ok, true);
  const second = await waitFor(
    () => {
      const state = alpha.states.latest();
      return state?.session?.phase === PHASES.QUIZ && state.round?.cycle === 2 && state.round.me.question
        ? state
        : null;
    },
    { label: 'second question round' },
  );
  assert.equal(second.round.number, 1, 'still the same game');
  assert.equal(second.round.me.question.number, 1);
  assert.equal(second.round.me.answered, 0, 'per-round counters restart');
  const carried = second.round.boards.find((board) => board.id === second.round.me.targetId);
  assert.equal(carried.shots.length, 1, 'the earlier shot is still on the board');

  const tooEarly = await emitAck(screen.socket, EVENTS.DISPLAY_FINISH, {});
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.error.code, 'INVALID_PHASE');
  const playerFinish = await emitAck(alpha.socket, EVENTS.DISPLAY_FINISH, {});
  assert.equal(playerFinish.ok, false);
  assert.equal(playerFinish.error.code, 'UNAUTHORIZED');

  // Skip to the briefing and end the game on score.
  assert.equal((await emitAck(screen.socket, EVENTS.DISPLAY_ADVANCE, {})).ok, true);
  await waitFor(() => latestPhase(screen.states, PHASES.REVIEW), { label: 'second briefing' });
  assert.equal((await emitAck(screen.socket, EVENTS.DISPLAY_FINISH, {})).ok, true);
  const result = await waitFor(() => latestPhase(screen.states, PHASES.RESULT), { label: 'result' });
  assert.equal(result.round.outcome.winnerName, 'ALPHA');
  assert.ok(result.round.boards.every((board) => Array.isArray(board.ships)));

  // Play again, then back to the lobby.
  assert.equal((await emitAck(screen.socket, EVENTS.DISPLAY_ADVANCE, {})).ok, true);
  await waitFor(() => latestPhase(screen.states, PHASES.QUIZ)?.round?.number === 2, { label: 'round two' });
  assert.equal((await emitAck(screen.socket, EVENTS.DISPLAY_LOBBY, {})).ok, true);
  const lobby = await waitFor(() => latestPhase(alpha.states, PHASES.LOBBY), { label: 'back to lobby' });
  assert.equal(lobby.round, null);
});

test('removing a player from the game screen disconnects their phone', async (t) => {
  const h = await bootTestServer();
  const sockets = [];
  t.after(async () => {
    closeAll(sockets);
    await h.close();
  });

  const screen = await startGameScreen(h.baseUrl, EVENTS);
  sockets.push(screen.socket);
  const player = await joinPlayer(h.baseUrl, EVENTS, screen.game.joinCode, 'Kickable');
  sockets.push(player.socket);
  let removed = false;
  player.socket.on(EVENTS.PLAYER_REMOVED, () => {
    removed = true;
  });

  const result = await emitAck(screen.socket, EVENTS.DISPLAY_REMOVE, { playerId: player.result.playerId });
  assert.equal(result.ok, true);
  await waitFor(() => removed, { label: 'player removed notice' });
  await waitFor(() => screen.states.latest()?.counts?.players === 0, { label: 'roster updated' });
});

test('a new game replaces the old one and closes it for everyone', async (t) => {
  const h = await bootTestServer();
  const sockets = [];
  t.after(async () => {
    closeAll(sockets);
    await h.close();
  });

  const first = await startGameScreen(h.baseUrl, EVENTS);
  sockets.push(first.socket);
  const player = await joinPlayer(h.baseUrl, EVENTS, first.game.joinCode, 'Leaver');
  sockets.push(player.socket);
  let closed = false;
  player.socket.on(EVENTS.SESSION_CLOSED, () => {
    closed = true;
  });

  const second = await emitAck(first.socket, EVENTS.DISPLAY_CREATE, { key: first.key });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.game.joinCode, first.game.joinCode);
  await waitFor(() => closed, { label: 'old players told the game closed' });
  assert.equal(h.manager.sessions.size, 1);
  assert.equal(h.manager.getByCode(first.game.joinCode), null);

  const stale = await fetch(`${h.baseUrl}/api/sessions/${first.game.joinCode}`);
  assert.equal(stale.status, 404);
});

test('a game and its players survive a full server restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-restart-'));
  const pgliteDir = path.join(root, 'pglite');

  let h = await bootTestServer({ pgliteDir });
  const screen = await startGameScreen(h.baseUrl, EVENTS);
  const code = screen.game.joinCode;
  const first = await joinPlayer(h.baseUrl, EVENTS, code, 'Restart One');
  await joinPlayer(h.baseUrl, EVENTS, code, 'Restart Two').then((p) => p.socket.close());
  assert.equal(first.result.ok, true);

  await h.manager.current().flush();
  screen.socket.close();
  first.socket.close();
  await h.close();

  h = await bootTestServer({ pgliteDir });
  t.after(async () => {
    await h.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const restored = h.manager.getByCode(code);
  assert.ok(restored, 'game was not restored after restart');
  assert.equal(restored.state.players.length, 2);
  assert.equal(restored.summary().connectedCount, 0);

  const resumedSocket = await connect(h.baseUrl);
  t.after(() => resumedSocket.close());
  const states = collectStates(resumedSocket);
  const resumed = await emitAck(resumedSocket, EVENTS.PLAYER_RESUME, {
    code,
    token: first.result.token,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.playerId, first.result.playerId);
  const state = await waitFor(() => states.latest()?.me?.name === 'Restart One' && states.latest(), {
    label: 'restored player projection',
  });
  assert.equal(state.counts.players, 2);

  // The original control key still works, so the facilitator can carry on.
  const screenBack = await connect(h.baseUrl);
  t.after(() => screenBack.close());
  const sub = await emitAck(screenBack, EVENTS.DISPLAY_SUBSCRIBE, { key: screen.key });
  assert.equal(sub.control, true);
});

test('a game restored mid-quiz keeps its timer and questions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-restart-quiz-'));
  const pgliteDir = path.join(root, 'pglite');

  let h = await bootTestServer({ pgliteDir });
  const screen = await startGameScreen(h.baseUrl, EVENTS);
  const code = screen.game.joinCode;
  await emitAck(screen.socket, EVENTS.DISPLAY_SETTINGS, { patch: { mode: 'duel' } });
  const player = await joinPlayer(h.baseUrl, EVENTS, code, 'Mid Quiz');
  await emitAck(screen.socket, EVENTS.DISPLAY_ADVANCE, {});
  const endsAt = h.manager.current().state.round.quizEndsAt;
  const promptBefore = h.manager.current().state.round.quiz[player.result.playerId].current.prompt;

  await h.manager.current().flush();
  screen.socket.close();
  player.socket.close();
  await h.close();

  h = await bootTestServer({ pgliteDir });
  t.after(async () => {
    await h.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const restored = h.manager.getByCode(code);
  assert.equal(restored.phase, PHASES.QUIZ);
  assert.equal(restored.state.round.quizEndsAt, endsAt);
  assert.equal(restored.state.round.quiz[player.result.playerId].current.prompt, promptBefore);
});

test('a facilitator PIN guards starting a game and replacing a running one', async (t) => {
  const h = await bootTestServer({ facilitatorPin: 'rocu' });
  const sockets = [];
  t.after(async () => {
    closeAll(sockets);
    await h.close();
  });

  const first = await connect(h.baseUrl);
  sockets.push(first);
  const sub = await emitAck(first, EVENTS.DISPLAY_SUBSCRIBE, {});
  assert.equal(sub.game, null);
  assert.equal(sub.pinRequired, true);

  assert.equal((await emitAck(first, EVENTS.DISPLAY_CREATE, {})).error.code, 'PIN_REQUIRED');
  assert.equal((await emitAck(first, EVENTS.DISPLAY_CREATE, { pin: 'nope' })).error.code, 'WRONG_PIN');
  assert.equal(h.manager.current(), null, 'nothing was created');

  const made = await emitAck(first, EVENTS.DISPLAY_CREATE, { pin: 'ROCU' });
  assert.equal(made.ok, true, 'the PIN is not case sensitive');
  assert.ok(made.key);

  // Forcing a replacement without the key or the PIN is refused.
  const intruder = await connect(h.baseUrl);
  sockets.push(intruder);
  const forced = await emitAck(intruder, EVENTS.DISPLAY_CREATE, { force: true });
  assert.equal(forced.ok, false);
  assert.equal(forced.error.code, 'PIN_REQUIRED');
  assert.equal(h.manager.current().joinCode, made.game.joinCode);

  // The screen that holds the key needs no PIN to start a new game.
  const again = await emitAck(first, EVENTS.DISPLAY_CREATE, { key: made.key });
  assert.equal(again.ok, true);
});

test('five wrong PINs lock further attempts for a while', async (t) => {
  const h = await bootTestServer({ facilitatorPin: 'rocu' });
  const socket = await connect(h.baseUrl);
  t.after(async () => {
    socket.close();
    await h.close();
  });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await emitAck(socket, EVENTS.DISPLAY_CREATE, { pin: `bad${i}` })).error.code, 'WRONG_PIN');
  }
  const locked = await emitAck(socket, EVENTS.DISPLAY_CREATE, { pin: 'rocu' });
  assert.equal(locked.ok, false);
  assert.equal(locked.error.code, 'PIN_LOCKED');
});

test('only the game screen can reset the players, and phones are told why', async (t) => {
  const h = await bootTestServer();
  const sockets = [];
  t.after(async () => {
    closeAll(sockets);
    await h.close();
  });
  const screen = await startGameScreen(h.baseUrl, EVENTS);
  sockets.push(screen.socket);
  const code = screen.game.joinCode;
  const player = await joinPlayer(h.baseUrl, EVENTS, code, 'Soon Gone');
  sockets.push(player.socket);
  const told = new Promise((resolve) => player.socket.once(EVENTS.PLAYER_REMOVED, resolve));

  const denied = await emitAck(player.socket, EVENTS.DISPLAY_RESET_PLAYERS, {});
  assert.equal(denied.ok, false);
  assert.equal(h.manager.current().state.players.length, 1);

  const done = await emitAck(screen.socket, EVENTS.DISPLAY_RESET_PLAYERS, {});
  assert.equal(done.ok, true);
  assert.equal(done.removed, 1);
  assert.equal((await told).reason, 'reset');
  assert.equal(h.manager.current().state.players.length, 0);
  assert.equal(h.manager.current().joinCode, code);
});
