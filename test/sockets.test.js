import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { io as Client } from 'socket.io-client';
import { attachSockets } from '../server/sockets/index.js';
import { makeGame, once, waitForState } from './helpers.js';

const clients = [];
const resources = [];

async function setup() {
  const { game, store } = makeGame({ gridCount: 2, mode: 'teams', questionSeconds: 0 });
  const server = http.createServer();
  const io = new SocketServer(server);
  const sockets = attachSockets(io, { game, store, hostPin: '4321' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  resources.push({ server, io, sockets });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { game, store, url };
}

function connect(url) {
  const socket = Client(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(socket);
  return socket;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const resource of resources.splice(0)) {
    resource.sockets.stop();
    resource.io.close();
    resource.server.closeAllConnections?.();
    await new Promise((resolve) => resource.server.close(resolve));
  }
});

test('a full round synchronises display, host and two phones', async () => {
  const { game, url } = await setup();

  const display = connect(url);
  await once(display, 'connect');
  display.emit('display:hello');
  const initialDisplay = await waitForState(display, (state) => state.role === 'display');
  assert.equal(initialDisplay.phase, 'lobby');

  const host = connect(url);
  await once(host, 'connect');
  host.emit('host:auth', { pin: '9999' });
  const denied = await once(host, 'host:denied');
  assert.match(denied.message, /incorrect/i);
  host.emit('host:auth', { pin: '4321' });
  const auth = await once(host, 'host:ok');
  assert.ok(auth.token);
  const hostState = await waitForState(host, (state) => state.role === 'host');
  assert.equal(hostState.canStart, false);

  const alpha = connect(url);
  await once(alpha, 'connect');
  const alphaStatePromise = waitForState(alpha, (state) => state.me?.name === 'Alice');
  alpha.emit('player:join', { code: game.code, name: 'Alice', teamId: 't1' });
  const alphaOk = await once(alpha, 'player:ok');
  const alphaState = await alphaStatePromise;
  assert.equal(alphaOk.resumed, false);
  assert.equal(alphaState.me.teamId, 't1');

  const bravo = connect(url);
  await once(bravo, 'connect');
  const bravoStatePromise = waitForState(bravo, (state) => state.me?.name === 'Bob');
  bravo.emit('player:join', { code: game.code, name: 'Bob', teamId: 't2' });
  await once(bravo, 'player:ok');
  await bravoStatePromise;

  const readyState = await waitForState(host, (state) => state.canStart === true);
  assert.deepEqual(readyState.startIssues, []);

  host.emit('host:start');
  const questionDisplay = await waitForState(display, (state) => state.phase === 'question');
  assert.ok(questionDisplay.question);
  assert.equal(questionDisplay.question.correctIndex, undefined);
  assert.ok(questionDisplay.grids.every((grid) => grid.cells.flat().every((cell) => cell !== 'ship')));

  const questionHost = await waitForState(host, (state) => state.phase === 'question' && state.question?.correctIndex !== undefined);
  const correct = questionHost.question.correctIndex;

  const answeredHost = waitForState(host, (state) => state.answerStats.details?.some((row) => row.name === 'Alice' && row.correct === true));
  alpha.emit('player:answer', { questionId: questionHost.question.id, optionIndex: correct });
  await answeredHost;

  const alphaAwarded = await waitForState(alpha, (state) => state.me?.missiles === 1);
  assert.equal(alphaAwarded.me.answer.correct, true);
  assert.equal(alphaAwarded.me.answer.awarded, true);

  host.emit('host:reveal');
  const revealDisplay = await waitForState(display, (state) => state.phase === 'reveal');
  assert.equal(revealDisplay.question.correctIndex, correct);
  assert.ok(revealDisplay.question.explanation.length > 10);

  host.emit('host:battle');
  await waitForState(display, (state) => state.phase === 'battle');

  const battleHost = await waitForState(host, (state) => state.phase === 'battle');
  const target = battleHost.grids.find((grid) => grid.ownerTeamId === 't2');
  const cell = target.ships[0].cells[0];
  const shotPromise = waitForState(display, (state) => state.shots.length > 0);
  alpha.emit('player:fire', { targetGridId: target.id, col: cell.col, row: cell.row, nonce: 'n1' });
  const afterShot = await shotPromise;
  assert.equal(afterShot.shots[0].coord, `${'ABCDEFGHIJ'[cell.col]}${cell.row + 1}`);

  const exhausted = await waitForState(alpha, (state) => state.me?.missiles === 0);
  assert.equal(exhausted.me.canFire, false);

  // No missiles left - a second shot must be rejected.
  const errorPromise = once(alpha, 'game:error');
  alpha.emit('player:fire', { targetGridId: target.id, col: 8, row: 8, nonce: 'n2' });
  const error = await errorPromise;
  assert.equal(error.code, 'NO_MISSILES');

  // Reconnect with the stored token and keep the same identity.
  const token = alphaOk.token;
  alpha.close();
  const again = connect(url);
  await once(again, 'connect');
  const resumeState = waitForState(again, (state) => state.me?.name === 'Alice');
  again.emit('player:resume', { token });
  const resumed = await once(again, 'player:ok');
  assert.equal(resumed.resumed, true);
  const restored = await resumeState;
  assert.equal(restored.me.teamId, 't1');
});

test('joining with a bad code and duplicate names is rejected', async () => {
  const { game, url } = await setup();
  const player = connect(url);
  await once(player, 'connect');

  const badCode = once(player, 'game:error');
  player.emit('player:join', { code: 'ZZZZZ', name: 'Eve', teamId: 't1' });
  assert.equal((await badCode).code, 'INVALID_CODE');

  player.emit('player:join', { code: game.code, name: 'Eve', teamId: 't1' });
  await waitForState(player, (state) => state.me?.name === 'Eve');

  const second = connect(url);
  await once(second, 'connect');
  const duplicate = once(second, 'game:error');
  second.emit('player:join', { code: game.code, name: 'Eve', teamId: 't2' });
  assert.equal((await duplicate).code, 'NAME_TAKEN');
});

test('host controls are unavailable without authentication', async () => {
  const { url } = await setup();
  const impostor = connect(url);
  await once(impostor, 'connect');
  impostor.emit('host:start');
  const error = await once(impostor, 'game:error');
  assert.equal(error.code, 'UNAUTHORIZED');
});

test('a restored snapshot keeps players, code and scores', async () => {
  const { game } = makeGame({ gridCount: 2, questionSeconds: 0 });
  game.join({ code: game.code, name: 'Alice', teamId: 't1' });
  game.join({ code: game.code, name: 'Bob', teamId: 't2' });
  game.start();
  const correct = game.round.question.correctIndex;
  const alice = [...game.players.values()][0];
  game.submitAnswer(alice.id, game.round.questionId, correct);
  const snapshot = JSON.parse(JSON.stringify(game.toJSON()));

  const revived = new (game.constructor)({ store: game.store, snapshot });
  assert.equal(revived.code, game.code);
  assert.equal(revived.players.size, 2);
  assert.equal(revived.phase, 'question');
  assert.equal(revived.getTeam(alice.teamId).missiles, 1);
  assert.equal(revived.players.get(alice.id).connected, false);
  revived.resumeAfterRestore();
  revived._clearTimer();
});
