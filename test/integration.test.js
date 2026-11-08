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

test('20 devices join, sync, switch teams, reconnect, lock and reach mission ready', async (t) => {
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

  const hostMission = await waitFor(
    () => {
      const state = hostStates.latest();
      return state?.session?.phase === PHASES.MISSION_READY ? state : null;
    },
    { label: 'host mission-ready state' },
  );
  assert.equal(hostMission.counts.players, 20);
  assert.equal(hostMission.session.config.lobbyLocked, true);

  const displayMission = await waitFor(
    () => {
      const state = displayStates.latest();
      return state?.session?.phase === PHASES.MISSION_READY ? state : null;
    },
    { label: 'display mission-ready state' },
  );
  assert.equal(displayMission.counts.players, 20);

  const playerMission = await waitFor(
    () => {
      const state = resumedStates.latest();
      return state?.session?.phase === PHASES.MISSION_READY ? state : null;
    },
    { label: 'player mission-ready state' },
  );
  assert.equal(playerMission.me.name, 'Operative 01');

  for (const state of [hostMission, displayMission, playerMission]) {
    const serialised = JSON.stringify(state);
    assert.ok(!serialised.includes('tokenHash'), 'mission state leaked tokenHash');
    assert.ok(!serialised.includes('nameKey'), 'mission state leaked nameKey');
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
      return latest?.session?.phase === PHASES.MISSION_READY ? latest : null;
    },
    { label: 'facilitator forced start' },
  );
  assert.equal(state.counts.players, 0);
  assert.equal(state.session.config.lobbyLocked, true);
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
      return latest?.session?.phase === PHASES.MISSION_READY ? latest : null;
    },
    { label: 'display forced start' },
  );
  assert.equal(state.counts.players, 0);
  assert.equal(state.session.config.lobbyLocked, true);
});
