import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG, MODES, PHASES, ROLES } from '../shared/constants.js';
import { hostProjection, playerProjection, publicProjection } from '../server/sessions/projections.js';
import { GameSession, createSessionState } from '../server/sessions/session.js';

class MemoryRepository {
  constructor() {
    this.saves = [];
    this.events = [];
  }

  async save(state) {
    this.saves.push(structuredClone(state));
  }

  appendEvent(sessionId, seq, type, payload = {}) {
    this.events.push({ sessionId, seq, type, payload });
  }
}

function makeSession(config = {}) {
  const repository = new MemoryRepository();
  const state = createSessionState({
    id: 's_test-lobby-0001',
    joinCode: 'ABC234',
    config: { ...DEFAULT_CONFIG, ...config },
    joinBaseUrl: 'http://localhost/play?code=ABC234',
    displayBaseUrl: 'http://localhost/display?code=ABC234',
  });
  const session = new GameSession({ state, repository, logger: null });
  return { session, repository };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

async function expectReject(fn, code) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

test('new sessions start in the lobby with configured teams', () => {
  const { session } = makeSession();
  assert.equal(session.phase, PHASES.LOBBY);
  assert.equal(session.state.teams.length, 2);
  assert.deepEqual(session.state.teams.map((team) => team.name), ['ALPHA', 'BRAVO']);
  assert.equal(session.state.players.length, 0);
  assert.equal(session.canStart().ok, false);
});

test('joining assigns a team, hashes the token and enforces unique names', () => {
  const { session } = makeSession();
  const { player, token } = session.join({ name: 'Neo' });

  assert.equal(player.role, ROLES.PLAYER);
  assert.equal(player.displayName, 'Neo');
  assert.equal(player.teamId, session.state.teams[0].id);
  assert.ok(token.length >= 20);
  assert.notEqual(player.tokenHash, token);
  assert.equal(session.resume(token).id, player.id);
  assert.equal(session.resume('not-a-real-token'), null);

  expectCode(() => session.join({ name: 'neo' }), 'NAME_TAKEN');
  expectCode(() => session.join({ name: 'A' }), 'INVALID_NAME');

  const second = session.join({ name: 'Trinity' });
  assert.equal(second.player.teamId, session.state.teams[1].id);
});

test('explicit team selection and capacity limits are enforced', () => {
  const { session } = makeSession({ maxPlayersPerTeam: 1, teamCount: 2 });
  const alpha = session.state.teams[0];
  const bravo = session.state.teams[1];

  const a = session.join({ name: 'Alpha One', teamId: alpha.id });
  const b = session.join({ name: 'Bravo One', teamId: bravo.id });
  assert.equal(a.player.teamId, alpha.id);
  assert.equal(b.player.teamId, bravo.id);

  expectCode(() => session.join({ name: 'Too Many', teamId: alpha.id }), 'TEAM_FULL');
  expectCode(() => session.join({ name: 'Auto Full' }), 'TEAM_FULL');
});

test('players can choose a team and the host can move them', async () => {
  const { session } = makeSession();
  const alpha = session.state.teams[0];
  const bravo = session.state.teams[1];
  const { player } = session.join({ name: 'Switch', teamId: alpha.id });
  session.join({ name: 'Stays', teamId: bravo.id });

  await session.chooseTeam(player.id, bravo.id);
  assert.equal(player.teamId, bravo.id);

  await session.movePlayer(player.id, alpha.id);
  assert.equal(player.teamId, alpha.id);

  await session.renameTeam(bravo.id, 'BLUE CREW');
  assert.equal(session.teamById(bravo.id).name, 'BLUE CREW');
  assert.deepEqual(session.state.config.teamNames, ['ALPHA', 'BLUE CREW']);
});

test('locking the lobby blocks new joins but allows updates to existing players', async () => {
  const { session } = makeSession();
  const { player } = session.join({ name: 'Early' });
  await session.lockLobby(true);

  assert.equal(session.config.lobbyLocked, true);
  expectCode(() => session.join({ name: 'Late' }), 'LOBBY_LOCKED');

  await session.lockLobby(false);
  assert.equal(session.join({ name: 'Late' }).player.nameKey, 'late');

  // Existing players may still be moved while the lobby is open.
  await session.movePlayer(player.id, session.state.teams[1].id);
  assert.equal(player.teamId, session.state.teams[1].id);
});

test('the operation can only start with players on every team', async () => {
  const { session } = makeSession();
  await expectReject(() => session.start(), 'CANNOT_START');

  session.join({ name: 'Alpha One', teamId: session.state.teams[0].id });
  const blocked = session.canStart();
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /BRAVO/);
  await expectReject(() => session.start(), 'CANNOT_START');

  session.join({ name: 'Bravo One', teamId: session.state.teams[1].id });
  assert.equal(session.canStart().ok, true);

  await session.start();
  assert.equal(session.phase, PHASES.MISSION_READY);
  assert.equal(session.config.lobbyLocked, true);
  assert.ok(session.state.startedAt);
  expectCode(() => session.join({ name: 'After Start' }), 'JOIN_CLOSED');

  await session.returnToLobby();
  assert.equal(session.phase, PHASES.LOBBY);
  assert.equal(session.config.lobbyLocked, false);
  assert.equal(session.state.startedAt, null);
});

test('free-for-all mode starts without teams', async () => {
  const { session } = makeSession({ mode: MODES.INDIVIDUAL });
  assert.equal(session.state.teams.length, 0);
  session.join({ name: 'Solo One' });
  session.join({ name: 'Solo Two' });
  assert.equal(session.canStart().ok, true);
  await session.start();
  assert.equal(session.phase, PHASES.MISSION_READY);
});

test('a forced start launches an empty lobby', async () => {
  const { session } = makeSession();
  assert.equal(session.canStart().ok, false);
  await session.start({ force: true });
  assert.equal(session.phase, PHASES.MISSION_READY);
  assert.equal(session.config.lobbyLocked, true);
  assert.ok(session.state.startedAt);
});

test('removing a player emits an event and persists the new roster', async () => {
  const { session, repository } = makeSession();
  const { player } = session.join({ name: 'Removable' });
  let removed = null;
  session.on('playerRemoved', (payload) => {
    removed = payload;
  });

  await session.removePlayer(player.id);
  assert.equal(session.state.players.length, 0);
  assert.deepEqual(removed, { playerId: player.id, name: 'Removable' });
  assert.ok(repository.events.some((event) => event.type === 'player_removed'));
});

test('projections never expose player token hashes or internal keys', () => {
  const { session } = makeSession();
  const { player } = session.join({ name: 'Secret Keeper' });
  session.join({ name: 'Watcher', asSpectator: true });

  const publicState = publicProjection(session);
  const hostState = hostProjection(session);
  const playerState = playerProjection(session, player.id);

  for (const [name, projection] of Object.entries({ publicState, hostState, playerState })) {
    const serialised = JSON.stringify(projection);
    assert.ok(!serialised.includes('tokenHash'), `${name} leaked tokenHash`);
    assert.ok(!serialised.includes('nameKey'), `${name} leaked nameKey`);
    assert.ok(!serialised.includes(player.tokenHash), `${name} leaked the token hash value`);
  }

  assert.equal(publicState.counts.players, 1);
  assert.equal(publicState.counts.spectators, 1);
  assert.equal(publicState.teams[0].playerCount, 1);
  assert.equal(publicState.join.url, 'http://localhost/ABC234');
  assert.equal(hostState.join.url, 'http://localhost/ABC234');
  assert.equal(playerState.join.url, 'http://localhost/ABC234');
  assert.equal(session.summary().joinUrl, 'http://localhost/ABC234');
  assert.equal(playerState.me.id, player.id);
  assert.equal(playerState.me.name, 'Secret Keeper');
  assert.equal(hostState.admin.canStart, false);
  assert.ok(hostState.events.some((event) => event.type === 'player_joined'));
});

test('commits persist a serialised snapshot of the lobby', async () => {
  const { session, repository } = makeSession();
  session.join({ name: 'Persisted' });
  await session.commit();

  assert.ok(repository.saves.length >= 1);
  const last = repository.saves[repository.saves.length - 1];
  assert.equal(last.players.length, 1);
  assert.equal(last.players[0].displayName, 'Persisted');
  assert.ok(last.teams.length === 2);
});
