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
  createSession,
  emitAck,
  loginHost,
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

test('20 devices join, sync, switch teams, reconnect, lock and reach the first question', async (t) => {
  const h = await bootTestServer();
  const sockets = [];
  t.after(async () => {
    closeAll(sockets);
    await h.close();
  });

  const cookie = await loginHost(h.baseUrl);
  const summary = await createSession(h.baseUrl, cookie, { maxPlayersPerTeam: 15 });

  const host = await connect(h.baseUrl, cookie);
  sockets.push(host);
  const hostStates = collectStates(host);
  const subscribed = await emitAck(host, EVENTS.HOST_SUBSCRIBE, { sessionId: summary.id });
  assert.equal(subscribed.ok, true);

  const display = await connect(h.baseUrl);
  sockets.push(display);
  const displayStates = collectStates(display);
  const displaySubscribed = await emitAck(display, EVENTS.DISPLAY_SUBSCRIBE, {
    code: summary.joinCode,
  });
  assert.equal(displaySubscribed.ok, true);

  // 20 independent devices enlist; automatic balancing fills ALPHA and BRAVO.
  const players = [];
  for (let index = 1; index <= 20; index += 1) {
    const socket = await connect(h.baseUrl);
    sockets.push(socket);
    const states = collectStates(socket);
    const result = await emitAck(socket, EVENTS.PLAYER_JOIN, {
      code: summary.joinCode,
      name: `Operative ${String(index).padStart(2, '0')}`,
      teamId: null,
      asSpectator: false,
    });
    assert.equal(result.ok, true, `join ${index} failed: ${JSON.stringify(result)}`);
    assert.ok(result.token);
    players.push({ socket, states, result });
  }

  const fullLobby = await waitFor(
    () => {
      const state = hostStates.latest();
      return state?.counts?.players === 20 && state.counts.connected === 20 ? state : null;
    },
    { label: 'host lobby with 20 connected players' },
  );
  assert.equal(fullLobby.teams.length, 2);
  assert.deepEqual(
    fullLobby.teams.map((team) => team.playerCount),
    [10, 10],
  );

  const displayLobby = await waitFor(
    () => {
      const state = displayStates.latest();
      return state?.counts?.players === 20 ? state : null;
    },
    { label: 'public display state with 20 players' },
  );
  assert.ok(!JSON.stringify(displayLobby).includes('tokenHash'));

  // A player sees its own projected identity and no private token material.
  const firstPlayerState = await waitFor(
    () => {
      const state = players[0].states.latest();
      return state?.me?.name === 'Operative 01' ? state : null;
    },
    { label: 'first player own projection' },
  );
  assert.equal(firstPlayerState.me.id, players[0].result.playerId);
  assert.ok(!JSON.stringify(firstPlayerState).includes('tokenHash'));

  // Public HTTP summary is safe and consistent with the socket projection.
  const publicSummary = await fetch(
    `${h.baseUrl}/api/sessions/${encodeURIComponent(summary.joinCode)}`,
  ).then((response) => response.json());
  assert.equal(publicSummary.counts.players, 20);
  assert.equal(publicSummary.counts.connected, 20);
  assert.equal(
    publicSummary.teams.reduce((total, team) => total + team.playerCount, 0),
    20,
  );
  const publicJson = JSON.stringify(publicSummary);
  assert.ok(!publicJson.includes('tokenHash'));
  assert.ok(!publicJson.includes('nameKey'));
  assert.equal(publicSummary.join.url, `${h.config.publicUrl}/${summary.joinCode}`);

  // The QR payload is the short URL, and /<CODE> redirects to the player app.
  const qrResponse = await fetch(
    `${h.baseUrl}/api/sessions/${encodeURIComponent(summary.joinCode)}/qr.svg`,
  );
  assert.equal(qrResponse.status, 200);
  assert.match(qrResponse.headers.get('content-type'), /image\/svg\+xml/);
  const shortResponse = await fetch(`${h.baseUrl}/${summary.joinCode}`, {
    redirect: 'manual',
  });
  assert.equal(shortResponse.status, 302);
  assert.equal(shortResponse.headers.get('location'), `/play?code=${summary.joinCode}`);
  const unknownShortResponse = await fetch(`${h.baseUrl}/ZZZZZZ`, { redirect: 'manual' });
  assert.notEqual(unknownShortResponse.status, 302);

  // Player-initiated team switch is reflected on the host console.
  const currentTeamId = firstPlayerState.me.teamId;
  const targetTeam = fullLobby.teams.find((team) => team.id !== currentTeamId);
  const switched = await emitAck(players[0].socket, EVENTS.PLAYER_CHOOSE_TEAM, {
    teamId: targetTeam.id,
  });
  assert.equal(switched.ok, true);

  const switchedLobby = await waitFor(
    () => {
      const state = hostStates.latest();
      const team = state?.teams?.find((entry) => entry.id === targetTeam.id);
      return team?.playerCount === 11 ? state : null;
    },
    { label: 'host state reflecting the team switch' },
  );
  assert.equal(
    switchedLobby.teams.find((team) => team.id === currentTeamId).playerCount,
    9,
  );

  // Locking closes enlistment for new devices.
  await emitAck(host, EVENTS.HOST_LOCK_LOBBY, { sessionId: summary.id, locked: true });
  const lateSocket = await connect(h.baseUrl);
  sockets.push(lateSocket);
  const lateJoin = await emitAck(lateSocket, EVENTS.PLAYER_JOIN, {
    code: summary.joinCode,
    name: 'Late Arrival',
    teamId: null,
    asSpectator: false,
  });
  assert.equal(lateJoin.ok, false);
  assert.equal(lateJoin.error.code, 'LOBBY_LOCKED');
  lateSocket.close();

  // Reconnecting with the stored token resumes the same player.
  const original = players[0];
  original.socket.disconnect();
  const resumedSocket = await connect(h.baseUrl);
  sockets.push(resumedSocket);
  const resumedStates = collectStates(resumedSocket);
  const resumed = await emitAck(resumedSocket, EVENTS.PLAYER_RESUME, {
    code: summary.joinCode,
    token: original.result.token,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.playerId, original.result.playerId);
  assert.equal(resumed.name, 'Operative 01');
  await waitFor(() => resumedStates.latest()?.me?.id === original.result.playerId, {
    label: 'resumed player projection',
  });

  await emitAck(host, EVENTS.HOST_LOCK_LOBBY, { sessionId: summary.id, locked: false });

  const started = await emitAck(host, EVENTS.HOST_START, { sessionId: summary.id });
  assert.equal(started.ok, true, JSON.stringify(started));

  const hostRound = await waitFor(
    () => {
      const state = hostStates.latest();
      return state?.session?.phase === PHASES.QUESTION ? state : null;
    },
    { label: 'host question state' },
  );
  assert.equal(hostRound.counts.players, 20);
  assert.equal(hostRound.session.config.lobbyLocked, true);
  assert.equal(hostRound.round.number, 1);
  assert.ok(hostRound.round.question);
  assert.equal(typeof hostRound.round.question.answerIndex, 'number');

  const displayRound = await waitFor(
    () => {
      const state = displayStates.latest();
      return state?.session?.phase === PHASES.QUESTION ? state : null;
    },
    { label: 'display question state' },
  );
  assert.equal(displayRound.counts.players, 20);
  assert.equal(displayRound.round.question.answerIndex, undefined);
  assert.equal(displayRound.round.question.explanation, undefined);

  const playerRoundState = await waitFor(
    () => {
      const state = resumedStates.latest();
      return state?.session?.phase === PHASES.QUESTION ? state : null;
    },
    { label: 'player question state' },
  );
  assert.equal(playerRoundState.me.name, 'Operative 01');
  assert.equal(playerRoundState.round.question.answerIndex, undefined);

  for (const state of [hostRound, displayRound, playerRoundState]) {
    const serialised = JSON.stringify(state);
    assert.ok(!serialised.includes('tokenHash'), 'round state leaked tokenHash');
    assert.ok(!serialised.includes('nameKey'), 'round state leaked nameKey');
  }

  // Joining after the mission starts is rejected by phase, not just the lock.
  const afterStart = await connect(h.baseUrl);
  sockets.push(afterStart);
  const closed = await emitAck(afterStart, EVENTS.PLAYER_JOIN, {
    code: summary.joinCode,
    name: 'Too Late',
    teamId: null,
    asSpectator: false,
  });
  assert.equal(closed.ok, false);
  assert.equal(closed.error.code, 'JOIN_CLOSED');
  afterStart.close();
});

test('a lobby and its players survive a full server restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-restart-'));
  const pgliteDir = path.join(root, 'pglite');

  let h = await bootTestServer({ pgliteDir });
  const cookie = await loginHost(h.baseUrl);
  const summary = await createSession(h.baseUrl, cookie, { maxPlayersPerTeam: 4 });

  const first = await connect(h.baseUrl);
  const firstJoin = await emitAck(first, EVENTS.PLAYER_JOIN, {
    code: summary.joinCode,
    name: 'Restart One',
    teamId: null,
    asSpectator: false,
  });
  assert.equal(firstJoin.ok, true);

  const second = await connect(h.baseUrl);
  const secondJoin = await emitAck(second, EVENTS.PLAYER_JOIN, {
    code: summary.joinCode,
    name: 'Restart Two',
    teamId: null,
    asSpectator: false,
  });
  assert.equal(secondJoin.ok, true);

  await h.manager.get(summary.id).flush();
  first.close();
  second.close();
  await h.close();

  h = await bootTestServer({ pgliteDir });
  t.after(async () => {
    await h.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const restored = h.manager.getByCode(summary.joinCode);
  assert.ok(restored, 'session was not restored after restart');
  assert.equal(restored.id, summary.id);
  assert.equal(restored.state.players.length, 2);
  assert.equal(restored.summary().connectedCount, 0);

  const resumedSocket = await connect(h.baseUrl);
  t.after(() => resumedSocket.close());
  const resumedStates = collectStates(resumedSocket);
  const resumed = await emitAck(resumedSocket, EVENTS.PLAYER_RESUME, {
    code: summary.joinCode,
    token: firstJoin.token,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.playerId, firstJoin.playerId);
  assert.equal(resumed.resumed, true);

  const state = await waitFor(
    () => {
      const latest = resumedStates.latest();
      return latest?.me?.id === firstJoin.playerId ? latest : null;
    },
    { label: 'restored player projection' },
  );
  assert.equal(state.me.name, 'Restart One');
  assert.equal(state.counts.players, 2);
  assert.equal(state.counts.connected, 1);
});

test('facilitator can force-start a round with no players', async (t) => {
  const h = await bootTestServer();
  const cookie = await loginHost(h.baseUrl);
  const host = await connect(h.baseUrl, cookie);
  t.after(async () => {
    host.close();
    await h.close();
  });

  const summary = await createSession(h.baseUrl, cookie);
  const states = collectStates(host);
  const subscribed = await emitAck(host, EVENTS.HOST_SUBSCRIBE, { sessionId: summary.id });
  assert.equal(subscribed.ok, true);

  const started = await emitAck(host, EVENTS.HOST_START, { sessionId: summary.id });
  assert.equal(started.ok, true);

  const state = await waitFor(
    () => {
      const latest = states.latest();
      return latest?.session?.phase === PHASES.QUESTION ? latest : null;
    },
    { label: 'facilitator forced start' },
  );
  assert.equal(state.counts.players, 0);
  assert.equal(state.session.config.lobbyLocked, true);
  assert.equal(state.round.number, 1);
  assert.ok(state.round.question);
});

test('battle command display can start a round with no players', async (t) => {
  const h = await bootTestServer();
  const display = await connect(h.baseUrl);
  t.after(async () => {
    display.close();
    await h.close();
  });

  const cookie = await loginHost(h.baseUrl);
  const summary = await createSession(h.baseUrl, cookie);
  const states = collectStates(display);
  const subscribed = await emitAck(display, EVENTS.DISPLAY_SUBSCRIBE, {
    code: summary.joinCode,
  });
  assert.equal(subscribed.ok, true);

  const started = await emitAck(display, EVENTS.DISPLAY_START, { code: summary.joinCode });
  assert.equal(started.ok, true);

  const state = await waitFor(
    () => {
      const latest = states.latest();
      return latest?.session?.phase === PHASES.QUESTION ? latest : null;
    },
    { label: 'display forced start' },
  );
  assert.equal(state.counts.players, 0);
  assert.equal(state.session.config.lobbyLocked, true);
  assert.equal(state.round.number, 1);
  assert.ok(state.round.question);
});

test('a full round runs questions, rewards missiles, resolves attacks and starts the next round', async (t) => {
  const h = await bootTestServer();
  const sockets = [];
  t.after(async () => {
    closeAll(sockets);
    await h.close();
  });

  const cookie = await loginHost(h.baseUrl);
  const summary = await createSession(h.baseUrl, cookie, { maxPlayersPerTeam: 2, roundMinutes: 2 });

  const host = await connect(h.baseUrl, cookie);
  sockets.push(host);
  const hostStates = collectStates(host);
  assert.equal(
    (await emitAck(host, EVENTS.HOST_SUBSCRIBE, { sessionId: summary.id })).ok,
    true,
  );

  const display = await connect(h.baseUrl);
  sockets.push(display);
  const displayStates = collectStates(display);
  assert.equal(
    (await emitAck(display, EVENTS.DISPLAY_SUBSCRIBE, { code: summary.joinCode })).ok,
    true,
  );

  const players = [];
  for (const name of ['Nova', 'Vector']) {
    const socket = await connect(h.baseUrl);
    sockets.push(socket);
    const states = collectStates(socket);
    const joined = await emitAck(socket, EVENTS.PLAYER_JOIN, {
      code: summary.joinCode,
      name,
      teamId: null,
      asSpectator: false,
    });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    players.push({ socket, states, playerId: joined.playerId, token: joined.token });
  }

  await waitFor(
    () => {
      const state = hostStates.latest();
      return state?.counts?.players === 2 && state.counts.connected === 2 ? state : null;
    },
    { label: 'host roster with two players' },
  );

  assert.equal((await emitAck(host, EVENTS.HOST_START, { sessionId: summary.id })).ok, true);

  const questionStates = [];
  for (const player of players) {
    questionStates.push(
      await waitFor(
        () => {
          const state = player.states.latest();
          return state?.session?.phase === PHASES.QUESTION && state.round?.question ? state : null;
        },
        { label: 'player question state' },
      ),
    );
  }
  assert.equal(questionStates[0].round.question.answerIndex, undefined);

  const hostQuestion = await waitFor(
    () => {
      const state = hostStates.latest();
      return state?.round?.question ? state : null;
    },
    { label: 'host question with answer key' },
  );
  const question = hostQuestion.round.question;
  const answerIndex = question.answerIndex;
  assert.equal(typeof answerIndex, 'number');

  const correctAnswer = await emitAck(players[0].socket, EVENTS.PLAYER_ANSWER, {
    questionNumber: question.number,
    optionIndex: answerIndex,
  });
  assert.equal(correctAnswer.ok, true, JSON.stringify(correctAnswer));
  assert.equal(correctAnswer.correct, true);
  assert.ok([1, 2, 3].includes(correctAnswer.reward));
  assert.equal(correctAnswer.missiles, correctAnswer.reward);

  const wrongAnswer = await emitAck(players[1].socket, EVENTS.PLAYER_ANSWER, {
    questionNumber: question.number,
    optionIndex: (answerIndex + 1) % question.options.length,
  });
  assert.equal(wrongAnswer.ok, true, JSON.stringify(wrongAnswer));
  assert.equal(wrongAnswer.correct, false);
  assert.equal(wrongAnswer.reward, 0);

  const revealed = await waitFor(
    () => {
      const state = displayStates.latest();
      return state?.round?.question?.revealed ? state : null;
    },
    { label: 'display answer reveal' },
  );
  assert.equal(revealed.round.question.answerIndex, answerIndex);
  assert.equal(revealed.round.answered, 2);

  assert.equal((await emitAck(host, EVENTS.HOST_ADVANCE, { sessionId: summary.id })).ok, true);

  const attacker = await waitFor(
    () => {
      const state = players[0].states.latest();
      return state?.session?.phase === PHASES.ATTACK && state.round?.me?.targetBoard
        ? state
        : null;
    },
    { label: 'player attack phase' },
  );
  assert.equal(attacker.round.me.missiles, correctAnswer.reward);
  assert.ok(attacker.round.me.attacksLimit >= 1);

  const hostAttack = await waitFor(
    () => {
      const state = hostStates.latest();
      return state?.session?.phase === PHASES.ATTACK ? state : null;
    },
    { label: 'host attack phase' },
  );
  assert.ok(hostAttack.round.attackEndsAt);

  const ownerId = attacker.round.me.ownerId;
  const targetBoard = hostAttack.round.boards.find(
    (board) => board.id === attacker.round.me.targetId,
  );
  assert.ok(targetBoard, 'target board is present on the host projection');
  const shipCell = targetBoard.ships[0].cells[0];

  const shot = await emitAck(players[0].socket, EVENTS.PLAYER_ATTACK, {
    x: shipCell.x,
    y: shipCell.y,
  });
  assert.equal(shot.ok, true, JSON.stringify(shot));
  assert.equal(shot.hit, true);
  assert.equal(shot.missiles, correctAnswer.reward - 1);

  const hitState = await waitFor(
    () => {
      const state = hostStates.latest();
      const score = state?.round?.scores?.find((entry) => entry.id === ownerId);
      return score?.hits === 1 ? state : null;
    },
    { label: 'host state with a registered hit' },
  );
  const score = hitState.round.scores.find((entry) => entry.id === ownerId);
  assert.ok(score.points >= 35);
  assert.equal(hitState.round.attacks.length, 1);

  assert.equal((await emitAck(host, EVENTS.HOST_ADVANCE, { sessionId: summary.id })).ok, true);

  const over = await waitFor(
    () => {
      const state = displayStates.latest();
      return state?.session?.phase === PHASES.ROUND_OVER && state.round?.outcome ? state : null;
    },
    { label: 'round over display state' },
  );
  assert.ok(over.round.outcome.winnerName);
  assert.ok(over.round.boards.every((board) => Array.isArray(board.ships)));

  // The next round starts immediately from the round-over screen.
  assert.equal((await emitAck(host, EVENTS.HOST_ADVANCE, { sessionId: summary.id })).ok, true);
  const nextRound = await waitFor(
    () => {
      const state = players[1].states.latest();
      return state?.session?.phase === PHASES.QUESTION && state.round?.number === 2
        ? state
        : null;
    },
    { label: 'second round question state' },
  );
  assert.equal(nextRound.round.number, 2);
  assert.ok(nextRound.round.question);

  // Facilitator can close the round and return everyone to the lobby.
  assert.equal((await emitAck(host, EVENTS.HOST_END_ROUND, { sessionId: summary.id })).ok, true);
  assert.equal(
    (await emitAck(host, EVENTS.HOST_RETURN_TO_LOBBY, { sessionId: summary.id })).ok,
    true,
  );
  const lobby = await waitFor(
    () => {
      const state = players[0].states.latest();
      return state?.session?.phase === PHASES.LOBBY ? state : null;
    },
    { label: 'player returned to lobby' },
  );
  assert.equal(lobby.round, null);
  assert.equal(lobby.session.config.lobbyLocked, false);
});
