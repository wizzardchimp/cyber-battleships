import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG, MODES, PHASES, ROLES } from '../shared/constants.js';
import { pickQuestion } from '../shared/questions.js';
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
  const { session } = makeSession({ allowLateJoin: false });
  await expectReject(() => session.start(), 'CANNOT_START');

  session.join({ name: 'Alpha One', teamId: session.state.teams[0].id });
  const blocked = session.canStart();
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /BRAVO/);
  await expectReject(() => session.start(), 'CANNOT_START');

  session.join({ name: 'Bravo One', teamId: session.state.teams[1].id });
  assert.equal(session.canStart().ok, true);

  await session.start();
  assert.equal(session.phase, PHASES.QUESTION);
  assert.equal(session.config.lobbyLocked, true);
  assert.ok(session.state.startedAt);
  assert.equal(session.state.round.number, 1);
  expectCode(() => session.join({ name: 'After Start' }), 'JOIN_CLOSED');

  await session.returnToLobby();
  assert.equal(session.phase, PHASES.LOBBY);
  assert.equal(session.config.lobbyLocked, false);
  assert.equal(session.state.startedAt, null);
});

test('free-for-all mode starts without teams', async () => {
  const { session } = makeSession({ mode: MODES.INDIVIDUAL });
  assert.equal(session.state.teams.length, 0);
  const first = session.join({ name: 'Solo One' });
  const second = session.join({ name: 'Solo Two' });
  assert.equal(session.canStart().ok, true);
  await session.start();
  assert.equal(session.phase, PHASES.QUESTION);
  const combatants = session.state.round.combatants;
  assert.equal(combatants.length, 2);
  assert.ok(combatants.every((combatant) => combatant.kind === 'player'));
  assert.equal(combatants.find((entry) => entry.id === first.player.id).targetId, second.player.id);
  assert.equal(combatants.find((entry) => entry.id === second.player.id).targetId, first.player.id);
});

test('a forced start launches an empty lobby', async () => {
  const { session } = makeSession();
  assert.equal(session.canStart().ok, false);
  await session.start({ force: true });
  assert.equal(session.phase, PHASES.QUESTION);
  assert.equal(session.config.lobbyLocked, true);
  assert.ok(session.state.startedAt);
  assert.equal(session.state.round.number, 1);
  assert.ok(session.state.round.question);
});

test('the age band caps how advanced questions can get', () => {
  for (let index = 0; index < 40; index += 1) {
    const cadet = pickQuestion({ difficulty: 'expert', ageGroup: '10-15', used: [] });
    assert.ok(['easy', 'medium'].includes(cadet.difficulty), cadet.difficulty);

    const junior = pickQuestion({ difficulty: 'hard', ageGroup: '15-20', used: [] });
    assert.equal(junior.difficulty, 'hard');

    const adult = pickQuestion({ difficulty: 'expert', ageGroup: 'adult', used: [] });
    assert.equal(adult.difficulty, 'expert');
  }
});

test('late joining is allowed during a live round when enabled', async () => {
  const { session } = makeSession({ allowLateJoin: true });
  const alpha = session.state.teams[0];
  const bravo = session.state.teams[1];
  session.join({ name: 'Alpha One', teamId: alpha.id });
  session.join({ name: 'Bravo One', teamId: bravo.id });
  await session.start();

  const question = session.state.round.question;
  const late = session.join({ name: 'Latecomer', teamId: bravo.id });
  assert.equal(late.player.teamId, bravo.id);
  assert.equal(session.phase, PHASES.QUESTION);
  assert.equal(session.state.round.combatants.length, 2);

  const answer = await session.answer(late.player.id, question.number, question.answerIndex);
  assert.equal(answer.correct, true);
  assert.equal(answer.ownerId, bravo.id);
  assert.equal(session.state.scores[bravo.id].correct, 1);

  const projection = playerProjection(session, late.player.id);
  assert.equal(projection.me.name, 'Latecomer');
  assert.equal(projection.round.me.ownerId, bravo.id);
  assert.ok(projection.round.me.targetBoard);
});

test('late joining is refused when disabled', async () => {
  const { session } = makeSession({ allowLateJoin: false });
  session.join({ name: 'Alpha One', teamId: session.state.teams[0].id });
  session.join({ name: 'Bravo One', teamId: session.state.teams[1].id });
  await session.start();
  expectCode(() => session.join({ name: 'Too Late' }), 'JOIN_CLOSED');
});

test('free-for-all late joiners get a fleet and join the targeting ring', async () => {
  const { session } = makeSession({ mode: MODES.INDIVIDUAL, allowLateJoin: true });
  session.join({ name: 'Alpha' });
  session.join({ name: 'Beta' });
  await session.start();

  const question = session.state.round.question;
  const late = session.join({ name: 'Gamma' });
  const combatants = session.state.round.combatants;
  assert.equal(combatants.length, 3);
  const ids = new Set(combatants.map((combatant) => combatant.id));
  for (const combatant of combatants) {
    assert.ok(ids.has(combatant.targetId), 'every combatant has a live target');
    assert.notEqual(combatant.targetId, combatant.id);
  }
  assert.ok(session.state.fleets[late.player.id], 'late joiner received a fleet');
  assert.equal(session.arsenalFor(late.player.id), 0);

  const answer = await session.answer(late.player.id, question.number, question.answerIndex);
  assert.equal(answer.correct, true);
  assert.equal(session.state.scores[late.player.id].correct, 1);
});

test('correct answers award missiles while hiding the answer from public projections', async () => {
  const { session } = makeSession();
  const alpha = session.state.teams[0];
  const bravo = session.state.teams[1];
  const { player: fast } = session.join({ name: 'Fast', teamId: alpha.id });
  const { player: slow } = session.join({ name: 'Slow', teamId: bravo.id });
  await session.start();

  const question = session.state.round.question;
  const publicState = publicProjection(session);
  assert.equal(publicState.round.question.answerIndex, undefined);
  assert.equal(publicState.round.question.explanation, undefined);
  assert.equal(publicState.round.answerTally, null);
  assert.equal(hostProjection(session).round.question.answerIndex, question.answerIndex);

  const correct = await session.answer(fast.id, question.number, question.answerIndex);
  assert.equal(correct.correct, true);
  assert.ok([1, 2, 3].includes(correct.reward), `unexpected reward ${correct.reward}`);
  assert.equal(correct.missiles, correct.reward);
  assert.equal(correct.ownerId, alpha.id);
  assert.equal(session.state.scores[alpha.id].correct, 1);
  assert.equal(session.state.scores[alpha.id].points, 10);

  await expectReject(
    () => session.answer(fast.id, question.number, question.answerIndex),
    'ALREADY_ANSWERED',
  );

  const wrong = await session.answer(
    slow.id,
    question.number,
    (question.answerIndex + 1) % question.options.length,
  );
  assert.equal(wrong.correct, false);
  assert.equal(wrong.reward, 0);
  assert.equal(session.state.scores[bravo.id].missilesEarned, 0);
  assert.equal(session.arsenalFor(bravo.id), 0);

  const revealed = publicProjection(session).round;
  assert.equal(revealed.question.revealed, true);
  assert.equal(revealed.question.answerIndex, question.answerIndex);
  assert.equal(revealed.answered, 2);
  assert.equal(revealed.allAnswered, true);

  await expectReject(
    () => session.answer(fast.id, question.number, question.answerIndex),
    'QUESTION_CLOSED',
  );
});

test('the attack phase consumes missiles, scores hits and closes the round', async () => {
  const { session } = makeSession();
  const alpha = session.state.teams[0];
  const bravo = session.state.teams[1];
  const { player: attacker } = session.join({ name: 'Gunner', teamId: alpha.id });
  session.join({ name: 'Target', teamId: bravo.id });
  await session.start();

  const question = session.state.round.question;
  await session.answer(attacker.id, question.number, question.answerIndex);
  const missilesBefore = session.arsenalFor(alpha.id);
  assert.ok(missilesBefore > 0);

  await session.advance();
  assert.equal(session.phase, PHASES.ATTACK);
  assert.ok(session.state.round.attackEndsAt);

  const combatant = session.state.round.combatants.find((entry) => entry.id === alpha.id);
  assert.notEqual(combatant.targetId, alpha.id);
  const targetFleet = session.state.fleets[combatant.targetId];
  const shipCell = targetFleet.ships[0].cells[0];

  const result = await session.attack(attacker.id, shipCell.x, shipCell.y);
  assert.equal(result.hit, true);
  assert.equal(result.missiles, missilesBefore - 1);
  assert.equal(result.attacksUsed, 1);
  assert.equal(result.attacksLimit, session.config.maxAttacksPerTeam);

  const score = session.state.scores[alpha.id];
  assert.equal(score.hits, 1);
  assert.equal(score.points, 35);

  await expectReject(
    () => session.attack(attacker.id, shipCell.x, shipCell.y),
    'CELL_ALREADY_TARGETED',
  );

  await session.advance();
  assert.equal(session.phase, PHASES.ROUND_OVER);
  const round = session.state.round;
  assert.ok(round.endedAt);
  assert.ok(round.outcome.winnerName);
  assert.equal(round.results.length, round.combatants.length);
  assert.equal(round.results.find((entry) => entry.id === alpha.id).points, 35);

  // Fleets are fully revealed once the round is over.
  const finished = publicProjection(session);
  assert.ok(finished.round.boards.every((board) => Array.isArray(board.ships)));
  assert.ok(finished.round.boards.every((board) => board.ships.length > 0));
});

test('the next round keeps cumulative scores and ammunition, then lobby reset clears them', async () => {
  const { session } = makeSession();
  const alpha = session.state.teams[0];
  const { player } = session.join({ name: 'Carry', teamId: alpha.id });
  session.join({ name: 'Opponent', teamId: session.state.teams[1].id });
  await session.start();

  const firstQuestion = session.state.round.question;
  const answered = await session.answer(player.id, firstQuestion.number, firstQuestion.answerIndex);
  const firstFleetCells = JSON.stringify(session.state.fleets[alpha.id].ships);
  await session.endRound();
  assert.equal(session.phase, PHASES.ROUND_OVER);

  await session.advance();
  assert.equal(session.phase, PHASES.QUESTION);
  assert.equal(session.state.round.number, 2);
  assert.equal(session.state.scores[alpha.id].points, 10);
  assert.equal(session.arsenalFor(alpha.id), answered.reward);
  assert.notEqual(JSON.stringify(session.state.fleets[alpha.id].ships), firstFleetCells);

  await session.returnToLobby();
  assert.equal(session.phase, PHASES.LOBBY);
  assert.equal(session.state.round, null);
  assert.deepEqual(session.state.scores, {});
  assert.deepEqual(session.state.fleets, {});
  assert.deepEqual(session.state.arsenal, {});
  assert.equal(session.config.lobbyLocked, false);
});

test('round timers reveal questions and move into the attack phase', async () => {
  const { session } = makeSession({ roundMinutes: 1, questionTimer: 5, tacticalSeconds: 10 });
  session.join({ name: 'Timed', teamId: session.state.teams[0].id });
  session.join({ name: 'Timer Two', teamId: session.state.teams[1].id });
  await session.start();

  const round = session.state.round;
  await session.tick(Date.parse(round.question.endsAt) + 1);
  assert.ok(session.state.round.question.revealedAt);
  assert.equal(session.phase, PHASES.QUESTION);

  // The quiz clock is still open, so the next question starts after the reveal.
  await session.tick(Date.parse(session.state.round.question.revealUntil) + 1);
  assert.equal(session.phase, PHASES.QUESTION);
  assert.equal(session.state.round.questionNumber, 2);
  assert.equal(session.state.round.question.revealedAt, null);

  // Let the quiz clock run out, then the reveal, and the attack phase begins.
  await session.tick(Date.parse(session.state.round.quizEndsAt));
  assert.equal(session.phase, PHASES.QUESTION);
  await session.tick(Date.parse(session.state.round.question.revealUntil) + 1);
  assert.equal(session.phase, PHASES.ATTACK);
  assert.ok(session.state.round.attackEndsAt);

  await session.tick(Date.parse(session.state.round.attackEndsAt) + 1);
  assert.equal(session.phase, PHASES.ROUND_OVER);
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
