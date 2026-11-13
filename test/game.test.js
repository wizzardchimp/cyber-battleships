import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG, MODES, PHASES, SCORING, TIMING } from '../shared/constants.js';
import { defaultQuestionsFor } from '../shared/questions.js';
import { createStaticQuestions } from '../server/questions/store.js';
import { playerProjection, publicProjection } from '../server/sessions/projections.js';
import { CPU_ID } from '../server/sessions/round.js';
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

function makeSession(config = {}, questionOverrides = {}) {
  const repository = new MemoryRepository();
  const state = createSessionState({
    id: 's_test-game-0001',
    joinCode: 'ABC234',
    config: { ...DEFAULT_CONFIG, ...config },
    joinBaseUrl: 'http://localhost/play?code=ABC234',
    displayBaseUrl: 'http://localhost/display?code=ABC234',
    controlKeyHash: 'secret-hash-value',
  });
  const session = new GameSession({
    state,
    repository,
    logger: null,
    questions: createStaticQuestions(questionOverrides),
  });
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

/** A started 3v3-style game with one player per side. */
async function startedDuel(config = {}) {
  const { session, repository } = makeSession({ mode: MODES.DUEL, ...config });
  const [alpha, bravo] = session.state.teams;
  const a = session.join({ name: 'Alice' });
  const b = session.join({ name: 'Bob' });
  await session.advance();
  return { session, repository, alpha, bravo, a: a.player, b: b.player };
}

function currentQuestion(session, playerId) {
  return session.state.round.quiz[playerId].current;
}

async function answerCorrectly(session, player) {
  const current = currentQuestion(session, player.id);
  return session.answer(player.id, current.number, current.answerIndex);
}

async function answerWrongly(session, player) {
  const current = currentQuestion(session, player.id);
  return session.answer(player.id, current.number, (current.answerIndex + 1) % 3);
}

// ------------------------------------------------------------------ lobby

test('a new game starts in the lobby as a 3 v 3', () => {
  const { session } = makeSession();
  assert.equal(session.phase, PHASES.LOBBY);
  assert.deepEqual(session.state.teams.map((team) => team.name), ['ALPHA', 'BRAVO']);
  assert.deepEqual(session.state.teams.map((team) => team.maxPlayers), [3, 3]);
  assert.equal(session.capacity(), 6);
  assert.equal(session.config.questionSet, 'easy');
});

test('joining balances the sides, hashes the token and enforces unique names', () => {
  const { session } = makeSession();
  const first = session.join({ name: 'Neo' });
  const second = session.join({ name: 'Trinity' });

  assert.notEqual(first.player.teamId, second.player.teamId);
  assert.ok(first.token.length >= 20);
  assert.notEqual(first.player.tokenHash, first.token);
  assert.equal(session.resume(first.token).id, first.player.id);
  assert.equal(session.resume('not-a-real-token'), null);

  expectCode(() => session.join({ name: 'neo' }), 'NAME_TAKEN');
  expectCode(() => session.join({ name: 'A' }), 'INVALID_NAME');
});

test('sides hold three players and the game fills up', () => {
  const { session } = makeSession();
  const [alpha] = session.state.teams;
  for (const name of ['A One', 'A Two', 'A Three']) session.join({ name, teamId: alpha.id });
  expectCode(() => session.join({ name: 'A Four', teamId: alpha.id }), 'TEAM_FULL');
  for (const name of ['B One', 'B Two', 'B Three']) session.join({ name });
  expectCode(() => session.join({ name: 'Extra' }), 'GAME_FULL');
});

test('mode presets set the number of sides and their size', () => {
  const duel = makeSession({ mode: MODES.DUEL }).session;
  assert.deepEqual(duel.state.teams.map((team) => team.maxPlayers), [1, 1]);

  const cpu = makeSession({ mode: MODES.CPU }).session;
  assert.equal(cpu.state.teams.length, 1);
  assert.equal(cpu.state.teams[0].maxPlayers, 20);
  assert.equal(cpu.capacity(), 20);
});

test('players can switch sides in the lobby while there is room', async () => {
  const { session } = makeSession();
  const [alpha, bravo] = session.state.teams;
  const { player } = session.join({ name: 'Switcher', teamId: alpha.id });
  await session.chooseTeam(player.id, bravo.id);
  assert.equal(player.teamId, bravo.id);
  await expectReject(() => session.chooseTeam(player.id, bravo.id), 'ALREADY_ON_TEAM');

  const cpu = makeSession({ mode: MODES.CPU }).session;
  const solo = cpu.join({ name: 'Solo' });
  await expectReject(() => cpu.chooseTeam(solo.player.id, cpu.state.teams[0].id), 'ONE_SIDE');
});

test('changing mode keeps players seated and refuses when too many are present', async () => {
  const { session } = makeSession();
  const alpha = session.state.teams[0];
  const one = session.join({ name: 'One', teamId: alpha.id });
  session.join({ name: 'Two' });
  session.join({ name: 'Three' });

  await expectReject(() => session.updateConfig({ mode: MODES.DUEL }), 'TOO_MANY_PLAYERS');
  assert.equal(session.config.mode, MODES.SQUAD);

  await session.updateConfig({ mode: MODES.CPU });
  assert.equal(session.state.teams.length, 1);
  assert.ok(session.state.players.every((player) => player.teamId === session.state.teams[0].id));

  const sideRemoved = session.state.players[2];
  await session.removePlayer(sideRemoved.id);
  await session.updateConfig({ mode: MODES.DUEL });
  assert.equal(session.state.teams.length, 2);
  const sides = session.state.players.map((player) => player.teamId);
  assert.equal(new Set(sides).size, 2, 'players are spread across both sides');
  assert.ok(session.teamById(one.player.teamId));
});

test('settings are validated and locked once a game starts', async () => {
  const { session } = makeSession();
  await expectReject(() => session.updateConfig({ questionSet: 'nope' }), 'UNKNOWN_SET');
  await session.updateConfig({ questionSet: 'complex', quizMinutes: 3, battleSeconds: 90 });
  assert.equal(session.config.questionSet, 'complex');
  assert.equal(session.config.quizMinutes, 3);

  session.join({ name: 'Solo' });
  await session.advance();
  await expectReject(() => session.updateConfig({ quizMinutes: 1 }), 'NOT_IN_LOBBY');
  await session.advance(); // briefing
  expectCode(() => session.join({ name: 'Late' }), 'JOIN_CLOSED');
});

// ------------------------------------------------------------------- quiz

test('starting the game gives every player their own question', async () => {
  const { session, a, b } = await startedDuel();
  assert.equal(session.phase, PHASES.QUIZ);
  assert.ok(session.state.round.quizEndsAt);

  const qa = currentQuestion(session, a.id);
  const qb = currentQuestion(session, b.id);
  assert.equal(qa.number, 1);
  assert.equal(qa.options.length, 3);
  assert.equal(qb.number, 1);
  assert.ok(qa.answerIndex >= 0 && qa.answerIndex <= 2);

  const view = playerProjection(session, a.id);
  assert.equal(view.round.me.question.prompt, qa.prompt);
  assert.equal(JSON.stringify(view).includes('answerIndex'), false);
  assert.equal(JSON.stringify(view).includes(qa.explanation), qa.explanation === '' ? true : false);
});

test('a forced start works with no players at all', async () => {
  const { session } = makeSession();
  await session.advance();
  assert.equal(session.phase, PHASES.QUIZ);
  assert.equal(session.state.round.combatants.length, 2);
});

test('a correct answer earns one missile and ten points; a wrong one earns nothing', async () => {
  const { session, alpha, bravo, a, b } = await startedDuel();

  const first = currentQuestion(session, a.id);
  const right = await answerCorrectly(session, a);
  assert.equal(right.correct, true);
  assert.equal(right.reward, SCORING.missilesPerCorrect);
  assert.equal(right.missiles, 1);
  assert.equal(right.correctIndex, first.answerIndex);
  assert.equal(session.state.scores[alpha.id].points, SCORING.correct);
  assert.equal(session.arsenalFor(alpha.id), 1);

  const wrong = await answerWrongly(session, b);
  assert.equal(wrong.correct, false);
  assert.equal(wrong.reward, 0);
  assert.equal(session.arsenalFor(bravo.id), 0);
  assert.equal(session.state.scores[bravo.id].answered, 1);
  assert.equal(session.state.scores[bravo.id].correct, 0);
});

test('the next question arrives immediately and questions do not repeat', async () => {
  const { session, a } = await startedDuel();
  const seen = new Set([currentQuestion(session, a.id).id]);
  for (let index = 0; index < 12; index += 1) {
    await answerCorrectly(session, a);
    const next = currentQuestion(session, a.id);
    assert.equal(next.number, index + 2);
    assert.ok(!seen.has(next.id), `question ${next.id} repeated`);
    seen.add(next.id);
  }
});

test('questions recycle once the whole set has been seen', async () => {
  const small = defaultQuestionsFor('easy').slice(0, 8);
  const { session, a } = await (async () => {
    const { session: s } = makeSession({ mode: MODES.DUEL }, { easy: small });
    const player = s.join({ name: 'Solo' });
    await s.advance();
    return { session: s, a: player.player };
  })();

  for (let index = 0; index < 20; index += 1) await answerCorrectly(session, a);
  assert.equal(currentQuestion(session, a.id).number, 21);
});

test('stale or invalid answers are rejected', async () => {
  const { session, a } = await startedDuel();
  const current = currentQuestion(session, a.id);
  await expectReject(() => session.answer(a.id, current.number + 5, 0), 'QUESTION_CHANGED');
  await expectReject(() => session.answer(a.id, current.number, 3), 'INVALID_ANSWER');
  await answerCorrectly(session, a);
  await expectReject(() => session.answer(a.id, current.number, 0), 'QUESTION_CHANGED');
});

test('answer positions are shuffled rather than always the same slot', async () => {
  const positions = new Set();
  for (let index = 0; index < 30; index += 1) {
    const { session } = makeSession({ mode: MODES.DUEL });
    const { player } = session.join({ name: 'Solo' });
    await session.advance();
    positions.add(currentQuestion(session, player.id).answerIndex);
  }
  assert.ok(positions.size > 1, 'correct answer moved between slots');
});

test('the quiz timer moves the game to the briefing and closes answers', async () => {
  const { session, a } = await startedDuel({ quizMinutes: 1 });
  await session.tick(Date.parse(session.state.round.quizEndsAt) - 1000);
  assert.equal(session.phase, PHASES.QUIZ);

  const current = currentQuestion(session, a.id);
  await session.tick(Date.parse(session.state.round.quizEndsAt) + 10);
  assert.equal(session.phase, PHASES.REVIEW);
  assert.equal(currentQuestion(session, a.id), null);
  void current;
});

test('the facilitator can skip the quiz timer', async () => {
  const { session } = await startedDuel();
  await session.advance();
  assert.equal(session.phase, PHASES.REVIEW);
});

test('late answers after the grace period are refused', async () => {
  const { session, a } = await startedDuel();
  session.state.round.quizEndsAt = new Date(Date.now() - TIMING.answerGraceMs - 500).toISOString();
  const current = currentQuestion(session, a.id);
  await expectReject(() => session.answer(a.id, current.number, 0), 'QUIZ_CLOSED');
});

// ----------------------------------------------------------------- briefing

test('the briefing reports each side with accuracy and missiles won', async () => {
  const { session, alpha, a, b } = await startedDuel();
  await answerCorrectly(session, a);
  await answerCorrectly(session, a);
  await answerWrongly(session, a);
  await answerWrongly(session, b);
  await session.advance();
  assert.equal(session.phase, PHASES.REVIEW);

  const view = publicProjection(session);
  const alphaRow = view.round.teams.find((team) => team.id === alpha.id);
  assert.equal(alphaRow.answered, 3);
  assert.equal(alphaRow.correct, 2);
  assert.equal(alphaRow.accuracy, 67);
  assert.equal(alphaRow.missiles, 2);
  assert.equal(alphaRow.won, 2);
  assert.equal(alphaRow.players[0].name, 'Alice');
  assert.equal(JSON.stringify(view).includes('answerIndex'), false);
});

// ------------------------------------------------------------------ battle

test('the battle starts a countdown and shows shots but never ship positions', async () => {
  const { session } = await startedDuel({ battleSeconds: 45 });
  await session.advance();
  await session.advance();
  assert.equal(session.phase, PHASES.BATTLE);
  const view = publicProjection(session);
  assert.ok(view.round.battleEndsAt);
  assert.ok(view.round.boards.every((board) => board.ships === undefined));
});

test('firing consumes a missile, scores a hit and rejects repeats', async () => {
  const { session, alpha, bravo, a } = await startedDuel();
  await answerCorrectly(session, a);
  await answerCorrectly(session, a);
  await session.advance();
  await session.advance();

  const target = session.state.fleets[bravo.id];
  const cell = target.ships[0].cells[0];
  const result = await session.attack(a.id, cell.x, cell.y);
  assert.equal(result.hit, true);
  assert.equal(result.missiles, 1);
  assert.equal(session.state.scores[alpha.id].hits, 1);
  assert.equal(session.state.scores[alpha.id].points, 2 * SCORING.correct + SCORING.hit);

  await expectReject(() => session.attack(a.id, cell.x, cell.y), 'CELL_ALREADY_TARGETED');
  await expectReject(() => session.attack(a.id, 99, 0), 'INVALID_COORDINATE');

  const free = [...Array(10).keys()]
    .flatMap((x) => [...Array(10).keys()].map((y) => ({ x, y })))
    .find(
      ({ x, y }) =>
        !target.ships.some((ship) => ship.cells.some((c) => c.x === x && c.y === y)),
    );
  const miss = await session.attack(a.id, free.x, free.y);
  assert.equal(miss.hit, false);
  assert.equal(miss.missiles, 0);
  await expectReject(() => session.attack(a.id, 0, 0), 'NO_MISSILES');
});

test('only the opposing grid can be attacked', async () => {
  const { session, alpha, bravo, a, b } = await startedDuel();
  await answerCorrectly(session, a);
  await answerCorrectly(session, b);
  await session.advance();
  await session.advance();

  const alphaView = playerProjection(session, a.id).round.me;
  assert.equal(alphaView.targetId, bravo.id);
  const bravoView = playerProjection(session, b.id).round.me;
  assert.equal(bravoView.targetId, alpha.id);
});

test('destroying a fleet ends the battle at once and wins the game', async () => {
  const { session, alpha, bravo, a } = await startedDuel();
  session.setArsenal(alpha.id, 40);
  await session.advance();
  await session.advance();

  const ships = session.state.fleets[bravo.id].ships;
  for (const ship of ships) {
    for (const cell of ship.cells) {
      if (session.phase !== PHASES.BATTLE) break;
      await session.attack(a.id, cell.x, cell.y);
    }
  }
  assert.equal(session.phase, PHASES.RESULT);
  const outcome = session.state.round.outcome;
  assert.equal(outcome.winnerId, alpha.id);
  assert.equal(outcome.reason, 'Fleet destroyed');
  assert.equal(outcome.humanWin, true);
});

test('when the battle timer ends the battle pauses for more questions', async () => {
  const { session, a } = await startedDuel();
  await answerCorrectly(session, a);
  await session.advance();
  await session.advance();
  await session.tick(Date.parse(session.state.round.battleEndsAt) + 10);
  assert.equal(session.phase, PHASES.RESUPPLY);
  assert.equal(session.state.round.battleEndReason, 'time');
  assert.equal(session.state.round.outcome, null, 'nobody has won yet');
});

test('ending the game on score picks the higher score, and level scores draw', async () => {
  const { session, alpha, a } = await startedDuel();
  await answerCorrectly(session, a);
  await session.advance();
  await session.advance();
  await session.finish();
  assert.equal(session.phase, PHASES.RESULT);
  assert.equal(session.state.round.outcome.winnerId, alpha.id);
  assert.equal(session.state.round.outcome.reason, 'Highest score');

  const drawn = await startedDuel();
  await drawn.session.advance();
  await drawn.session.advance();
  await drawn.session.finish();
  assert.equal(drawn.session.state.round.outcome.draw, true);
  assert.equal(drawn.session.state.round.outcome.winnerName, 'DRAW');
});

test('the battle pauses when nobody has missiles left', async () => {
  const { session } = await startedDuel();
  await session.advance();
  await session.advance();
  const start = Date.parse(session.state.round.battleStartedAt);
  await session.tick(start + 500);
  assert.equal(session.phase, PHASES.BATTLE, 'a short grace period keeps the screen up');
  await session.tick(start + TIMING.minBattleMs + 100);
  assert.equal(session.phase, PHASES.RESUPPLY);
  assert.equal(session.state.round.battleEndReason, 'ammo');
});

test('running out of missiles leads to another question round that keeps the battle going', async () => {
  const { session, alpha, bravo, a, b } = await startedDuel();
  await answerCorrectly(session, a);
  await answerCorrectly(session, b);
  const firstQuestions = new Set([currentQuestion(session, a.id).id]);
  await session.advance();
  await session.advance();

  // Each side spends its single missile.
  const alphaTarget = session.state.fleets[bravo.id];
  const hitCell = alphaTarget.ships[0].cells[0];
  await session.attack(a.id, hitCell.x, hitCell.y);
  const bravoTarget = session.state.fleets[alpha.id];
  const free = [...Array(10).keys()]
    .flatMap((x) => [...Array(10).keys()].map((y) => ({ x, y })))
    .find(({ x, y }) => !bravoTarget.ships.some((ship) => ship.cells.some((c) => c.x === x && c.y === y)));
  await session.attack(b.id, free.x, free.y);
  const start = Date.parse(session.state.round.battleStartedAt);
  await session.tick(start + TIMING.minBattleMs + 100);
  assert.equal(session.phase, PHASES.RESUPPLY);
  const shipsBefore = JSON.stringify(session.state.fleets[bravo.id].ships);
  const pointsBefore = session.state.scores[alpha.id].points;

  await session.advance();
  assert.equal(session.phase, PHASES.QUIZ);
  assert.equal(session.state.round.cycle, 2);
  assert.equal(session.state.round.number, 1, 'still the same game');
  assert.equal(JSON.stringify(session.state.fleets[bravo.id].ships), shipsBefore, 'fleets are unchanged');
  assert.equal(session.state.fleets[bravo.id].shots.length, 1, 'earlier shots stay on the board');
  assert.equal(session.state.scores[alpha.id].points, pointsBefore);
  assert.equal(session.arsenalFor(alpha.id), 0);

  const next = currentQuestion(session, a.id);
  assert.equal(next.number, 1, 'question numbers restart each round');
  assert.ok(!firstQuestions.has(next.id), 'players do not see repeats');

  await answerCorrectly(session, a);
  await answerCorrectly(session, a);
  assert.equal(session.arsenalFor(alpha.id), 2);
  await session.advance();
  const briefing = publicProjection(session).round.teams.find((team) => team.id === alpha.id);
  assert.equal(briefing.won, 2, 'the briefing counts only this round');
  assert.equal(briefing.answered, 2);
  assert.equal(briefing.missiles, 2);

  await session.advance();
  assert.equal(session.phase, PHASES.BATTLE);
  const result = await session.attack(a.id, 9, 9);
  assert.equal(result.missiles, 1);
  assert.equal(session.state.fleets[bravo.id].shots.length, 2);
});

test('missiles left over when time runs out can be fired after resuming', async () => {
  const { session, alpha, a } = await startedDuel();
  await answerCorrectly(session, a);
  await answerCorrectly(session, a);
  await session.advance();
  await session.advance();
  await session.tick(Date.parse(session.state.round.battleEndsAt) + 10);
  assert.equal(session.phase, PHASES.RESUPPLY);
  assert.equal(session.arsenalFor(alpha.id), 2);

  await session.resumeFight();
  assert.equal(session.phase, PHASES.BATTLE);
  assert.equal(session.state.round.battleEndReason, null);
  assert.ok(Date.parse(session.state.round.battleEndsAt) > Date.now());
  assert.equal(session.arsenalFor(alpha.id), 2);
});

test('the battle cannot resume when nobody has missiles', async () => {
  const { session } = await startedDuel();
  await session.advance();
  await session.advance();
  await session.advance();
  assert.equal(session.phase, PHASES.RESUPPLY);
  await expectReject(() => session.resumeFight(), 'NO_MISSILES');
});

test('the game only ends when a fleet is sunk, even across several question rounds', async () => {
  const { session, alpha, bravo, a } = await startedDuel();
  const ships = session.state.fleets[bravo.id].ships;
  const cells = ships.flatMap((ship) => ship.cells);

  let fired = 0;
  let cycles = 1;
  while (session.phase !== PHASES.RESULT && cycles < 12) {
    session.setArsenal(alpha.id, 5);
    if (session.phase === PHASES.QUIZ) await session.advance();
    if (session.phase === PHASES.REVIEW) await session.advance();
    for (let shot = 0; shot < 5 && session.phase === PHASES.BATTLE; shot += 1) {
      const cell = cells[fired];
      fired += 1;
      await session.attack(a.id, cell.x, cell.y);
    }
    if (session.phase === PHASES.BATTLE) {
      await session.advance();
    }
    if (session.phase === PHASES.RESUPPLY) {
      await session.advance();
      cycles += 1;
    }
  }

  assert.equal(session.phase, PHASES.RESULT);
  assert.ok(cycles > 1, 'it took more than one question round');
  assert.equal(session.state.round.outcome.winnerId, alpha.id);
  assert.equal(session.state.round.outcome.reason, 'Fleet destroyed');
  assert.ok(session.state.fleets[bravo.id].ships.every((ship) => ship.sunk));
});

test('the facilitator can end the game early from the briefing or a paused battle', async () => {
  const { session } = await startedDuel();
  await expectReject(() => session.finish(), 'INVALID_PHASE');
  await session.advance();
  await session.finish();
  assert.equal(session.phase, PHASES.RESULT);
  assert.equal(session.state.round.outcome.draw, true);

  await session.advance();
  await session.advance();
  await session.advance();
  await session.advance();
  assert.equal(session.phase, PHASES.RESUPPLY);
  await session.finish();
  assert.equal(session.phase, PHASES.RESULT);
});

test('every question offers exactly three answers with the right one included', async () => {
  const { session, a } = await startedDuel();
  for (let index = 0; index < 20; index += 1) {
    const current = currentQuestion(session, a.id);
    assert.equal(current.options.length, 3);
    assert.equal(new Set(current.options).size, 3);
    assert.ok(current.answerIndex >= 0 && current.answerIndex < 3);
    await answerCorrectly(session, a);
  }
});

test('older four-answer questions are trimmed to three when they are served', async () => {
  const legacy = Array.from({ length: 8 }, (_, index) => ({
    id: `old-${index}`,
    category: 'Old',
    prompt: `Old question ${index}?`,
    options: ['Right', 'Wrong one', 'Wrong two', 'Wrong three'],
    answerIndex: 0,
    explanation: '',
  }));
  const { session } = makeSession({ mode: MODES.DUEL }, { easy: legacy });
  const { player } = session.join({ name: 'Legacy' });
  await session.advance();
  const current = currentQuestion(session, player.id);
  assert.equal(current.options.length, 3);
  assert.equal(current.options[current.answerIndex], 'Right');
});

test('everyone vs CPU: the crew wins by breaching the firewall', async () => {
  const { session, repository } = makeSession({ mode: MODES.CPU });
  const [crew] = session.state.teams;
  session.join({ name: 'Ace' });
  session.join({ name: 'Bee' });
  await session.advance();

  const combatants = session.state.round.combatants;
  assert.equal(combatants.length, 2);
  assert.equal(combatants.find((entry) => entry.id === crew.id).targetId, CPU_ID);

  session.setArsenal(crew.id, 60);
  await session.advance();
  await session.advance();
  for (const ship of session.state.fleets[CPU_ID].ships) {
    for (const cell of ship.cells) {
      if (session.phase !== PHASES.BATTLE) break;
      await session.attack(crew.captainPlayerId, cell.x, cell.y);
    }
  }
  assert.equal(session.phase, PHASES.RESULT);
  assert.equal(session.state.round.outcome.reason, 'Firewall breached');
  assert.equal(session.state.round.outcome.humanWin, true);
  assert.ok(repository.saves.length > 0);
});

test('everyone vs CPU: the firewall holds if the game is ended early', async () => {
  const { session } = makeSession({ mode: MODES.CPU });
  session.join({ name: 'Ace' });
  await session.advance(); // start quiz
  await session.advance(); // skip to briefing
  await session.advance(); // start battle
  await session.finish(); // facilitator ends the game
  assert.equal(session.phase, PHASES.RESULT);
  assert.equal(session.state.round.outcome.reason, 'Firewall held');
  assert.equal(session.state.round.outcome.humanWin, false);
});

// ------------------------------------------------------------- after result

test('play again starts a clean round with the same players', async () => {
  const { session, alpha, a } = await startedDuel();
  await answerCorrectly(session, a);
  await session.advance();
  await session.advance();
  await session.finish();
  assert.equal(session.phase, PHASES.RESULT);
  const firstFleet = JSON.stringify(session.state.fleets[alpha.id].ships);

  await session.advance();
  assert.equal(session.phase, PHASES.QUIZ);
  assert.equal(session.state.round.number, 2);
  assert.equal(session.state.round.cycle, 1);
  assert.equal(session.state.scores[alpha.id].points, 0);
  assert.equal(session.arsenalFor(alpha.id), 0);
  assert.notEqual(JSON.stringify(session.state.fleets[alpha.id].ships), firstFleet);
  assert.equal(session.state.players.length, 2);
  assert.equal(currentQuestion(session, a.id).number, 1);
});

test('returning to the lobby clears the round and reopens joining', async () => {
  const { session } = await startedDuel();
  await session.returnToLobby();
  assert.equal(session.phase, PHASES.LOBBY);
  assert.equal(session.state.round, null);
  assert.deepEqual(session.state.fleets, {});
  assert.equal(session.state.players.length, 2);
  expectCode(() => session.join({ name: 'Third' }), 'GAME_FULL');
  await session.removePlayer(session.state.players[0].id);
  assert.equal(session.join({ name: 'Third' }).player.displayName, 'Third');
});

test('players can be removed at any time', async () => {
  const { session, a } = await startedDuel();
  let removed = null;
  session.on('playerRemoved', (payload) => {
    removed = payload;
  });
  await session.removePlayer(a.id);
  assert.equal(session.state.players.length, 1);
  assert.deepEqual(removed, { playerId: a.id, name: 'Alice' });
  assert.equal(session.state.round.quiz[a.id], undefined);
});

// -------------------------------------------------------------- projections

test('projections never expose tokens, the control key or answer keys', async () => {
  const { session, a } = await startedDuel();
  const views = {
    display: publicProjection(session, { control: true }),
    player: playerProjection(session, a.id),
  };
  for (const [name, view] of Object.entries(views)) {
    const text = JSON.stringify(view);
    assert.ok(!text.includes('tokenHash'), `${name} leaked tokenHash`);
    assert.ok(!text.includes('nameKey'), `${name} leaked nameKey`);
    assert.ok(!text.includes('controlKey'), `${name} leaked the control key`);
    assert.ok(!text.includes('secret-hash-value'), `${name} leaked the control key hash`);
    assert.ok(!text.includes('answerIndex'), `${name} leaked an answer key`);
  }
  assert.equal(views.display.viewer.control, true);
  assert.equal(publicProjection(session).viewer.control, false);
  assert.equal(views.display.join.url, 'http://localhost/ABC234');
  assert.equal(views.display.questionSets.length, 2);
});

test('ship positions are revealed only after the result', async () => {
  const { session, a } = await startedDuel();
  await session.advance();
  await session.advance();
  assert.ok(playerProjection(session, a.id).round.boards.every((board) => !board.ships));
  await session.advance();
  assert.equal(session.phase, PHASES.RESUPPLY);
  assert.ok(publicProjection(session).round.boards.every((board) => !board.ships));
  await session.finish();
  assert.equal(session.phase, PHASES.RESULT);
  assert.ok(publicProjection(session).round.boards.every((board) => board.ships.length === 5));
});

test('commits persist a serialised snapshot of the game', async () => {
  const { session, repository } = makeSession();
  session.join({ name: 'Persisted' });
  await session.commit();
  assert.ok(repository.saves.length >= 1);
  const last = repository.saves[repository.saves.length - 1];
  assert.equal(last.players[0].displayName, 'Persisted');
  assert.equal(last.schemaVersion, 3);
});

// ------------------------------------------------------------ streak bonus

test('three correct answers in a row earn bonus missiles, which stop after five', async () => {
  const { session, a } = await startedDuel();
  const rewards = [];
  for (let index = 0; index < 7; index += 1) {
    const result = await answerCorrectly(session, a);
    rewards.push([result.streak, result.bonus, result.reward]);
  }
  assert.deepEqual(rewards, [
    [1, 0, 1],
    [2, 0, 1],
    [3, 1, 2],
    [4, 1, 2],
    [5, 1, 2],
    [6, 0, 1],
    [7, 0, 1],
  ]);
  assert.equal(session.arsenalFor(session.state.teams[0].id), 1 + 1 + 2 + 2 + 2 + 1 + 1);
});

test('a wrong answer breaks the streak and the bonus needs three in a row again', async () => {
  const { session, a } = await startedDuel();
  await answerCorrectly(session, a);
  await answerCorrectly(session, a);
  const wrong = await answerWrongly(session, a);
  assert.equal(wrong.streak, 0);
  assert.equal(wrong.bonus, 0);
  assert.equal((await answerCorrectly(session, a)).bonus, 0);
  assert.equal((await answerCorrectly(session, a)).bonus, 0);
  assert.equal((await answerCorrectly(session, a)).bonus, 1);
});

test('the briefing counts bonus missiles in what a side won', async () => {
  const { session, a } = await startedDuel();
  for (let index = 0; index < 3; index += 1) await answerCorrectly(session, a);
  const alpha = session.teamProgress().find((team) => team.players.some((player) => player.id === a.id));
  assert.equal(alpha.won, 4);
});

// ------------------------------------------------------------------ captains

async function startedSquad() {
  const { session } = makeSession({ mode: MODES.SQUAD });
  const [alpha, bravo] = session.state.teams;
  const alphaPlayers = ['A One', 'A Two', 'A Three'].map(
    (name) => session.join({ name, teamId: alpha.id }).player,
  );
  const bravoPlayers = ['B One', 'B Two', 'B Three'].map(
    (name) => session.join({ name, teamId: bravo.id }).player,
  );
  await session.advance();
  return { session, alpha, bravo, alphaPlayers, bravoPlayers };
}

test('each side gets exactly one captain, and only the captain can fire', async () => {
  const { session, alpha, alphaPlayers } = await startedSquad();
  for (const player of alphaPlayers) await answerCorrectly(session, player);
  await session.advance(); // briefing
  await session.advance(); // battle

  const captain = alphaPlayers.find((player) => player.id === alpha.captainPlayerId);
  assert.ok(captain, 'a captain from the side was chosen');
  for (const player of alphaPlayers.filter((entry) => entry.id !== captain.id)) {
    await expectReject(() => session.attack(player.id, 0, 0), 'NOT_CAPTAIN');
  }
  assert.equal((await session.attack(captain.id, 0, 0)).missiles, 2);

  const view = playerProjection(session, alphaPlayers[0].id);
  assert.equal(view.round.me.isCaptain, alphaPlayers[0].id === captain.id);
  assert.equal(view.round.me.captainName, captain.displayName);
  const roster = publicProjection(session).teams[0].players;
  assert.equal(roster.filter((entry) => entry.captain).length, 1);
});

test('a new captain is chosen for each question round', async () => {
  const { session, alpha, alphaPlayers } = await startedSquad();
  const seen = [alpha.captainPlayerId];
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await session.advance(); // briefing
    await session.advance(); // battle
    await session.advance(); // paused
    await session.advance(); // next question round
    seen.push(alpha.captainPlayerId);
  }
  assert.notEqual(seen[0], seen[1]);
  assert.notEqual(seen[1], seen[2]);
  assert.equal(new Set(seen).size, 3, 'everyone gets a turn before anyone repeats');
  assert.ok(seen.every((id) => alphaPlayers.some((player) => player.id === id)));
});

test('a lone player is always the captain', async () => {
  const { session, alpha, a } = await startedDuel();
  assert.equal(alpha.captainPlayerId, a.id);
});

test('an offline captain is replaced during battle', async () => {
  const { session, alpha, alphaPlayers } = await startedSquad();
  await session.advance();
  await session.advance();
  const before = alpha.captainPlayerId;
  await session.setConnected(before, false);
  assert.notEqual(alpha.captainPlayerId, before);
  assert.ok(alphaPlayers.some((player) => player.id === alpha.captainPlayerId));
});

test('in a crew game against the CPU one player fires for everybody', async () => {
  const { session } = makeSession({ mode: MODES.CPU });
  const players = ['One', 'Two', 'Three', 'Four'].map((name) => session.join({ name }).player);
  await session.advance();
  const crew = session.state.teams[0];
  assert.ok(players.some((player) => player.id === crew.captainPlayerId));
});

test('the captain can pass the controls to a teammate, and nobody else can', async () => {
  const { session, alpha, bravo, alphaPlayers, bravoPlayers } = await startedSquad();
  for (const player of alphaPlayers) await answerCorrectly(session, player);
  await session.advance(); // briefing
  await session.advance(); // battle

  const captain = alphaPlayers.find((player) => player.id === alpha.captainPlayerId);
  const [other, third] = alphaPlayers.filter((player) => player.id !== captain.id);
  await expectReject(() => session.passCaptain(other.id, third.id), 'NOT_CAPTAIN');
  await expectReject(() => session.passCaptain(captain.id, captain.id), 'INVALID_PLAYER');
  await expectReject(() => session.passCaptain(captain.id, bravoPlayers[0].id), 'INVALID_PLAYER');

  await session.passCaptain(captain.id, other.id);
  assert.equal(alpha.captainPlayerId, other.id);
  assert.notEqual(bravo.captainPlayerId, other.id);
  await expectReject(() => session.attack(captain.id, 0, 0), 'NOT_CAPTAIN');
  assert.equal((await session.attack(other.id, 0, 0)).missiles, 2);
});

test('players can join while questions are running, but not during the battle', async () => {
  const { session } = makeSession({ mode: MODES.SQUAD });
  const alpha = session.state.teams[0];
  session.join({ name: 'First', teamId: alpha.id });
  await session.advance();
  const late = session.join({ name: 'Late Joiner', teamId: alpha.id }).player;
  const view = playerProjection(session, late.id);
  assert.ok(view.round.me.question, 'a late joiner gets a question straight away');
  await session.advance(); // briefing
  expectCode(() => session.join({ name: 'Too Late', teamId: alpha.id }), 'JOIN_CLOSED');
});

// -------------------------------------------------------------- three teams

async function startedFleet() {
  const { session } = makeSession({ mode: MODES.FLEET });
  const [alpha, bravo, charlie] = session.state.teams;
  const make = (team, tag) =>
    ['One', 'Two', 'Three', 'Four'].map((n) => session.join({ name: `${tag} ${n}`, teamId: team.id }).player);
  const a = make(alpha, 'A');
  const b = make(bravo, 'B');
  const c = make(charlie, 'C');
  await session.advance();
  return { session, alpha, bravo, charlie, a, b, c };
}

function sinkEverything(session, targetId) {
  const fleet = session.state.fleets[targetId];
  const cells = fleet.ships.flatMap((ship) => ship.cells);
  return cells;
}

test('the three-team mode holds three sides of twenty with a third of a missile per correct answer', async () => {
  const { session, alpha, a } = await startedFleet();
  assert.equal(session.state.teams.length, 3);
  assert.equal(alpha.maxPlayers, 20);

  const first = await answerCorrectly(session, a[0]);
  assert.equal(first.reward, 0, 'one correct answer is only a third of a missile');
  assert.equal(first.perMissile, 3);
  assert.equal(first.progress, 1);
  assert.equal(session.arsenalFor(alpha.id), 0);
  await answerCorrectly(session, a[1]);
  const third = await answerCorrectly(session, a[2]);
  assert.equal(third.reward, 1, 'the third correct answer earns a whole missile');
  assert.equal(third.progress, 0);
  assert.equal(session.arsenalFor(alpha.id), 1);
});

test('a captain picks which of the two other fleets to fire at', async () => {
  const { session, alpha, bravo, charlie, a, b, c } = await startedFleet();
  for (const player of [...a, ...b, ...c]) {
    for (let i = 0; i < 3; i += 1) await answerCorrectly(session, player);
  }
  await session.advance(); // briefing
  await session.advance(); // battle

  const captain = a.find((player) => player.id === alpha.captainPlayerId);
  const view = playerProjection(session, captain.id);
  assert.deepEqual([...view.round.me.targetIds].sort(), [bravo.id, charlie.id].sort());
  assert.equal(view.round.me.targetBoards.length, 2);

  await expectReject(() => session.attack(captain.id, 0, 0), 'CHOOSE_TARGET');
  await expectReject(() => session.attack(captain.id, 0, 0, alpha.id), 'INVALID_TARGET');
  const shot = await session.attack(captain.id, 0, 0, charlie.id);
  assert.equal(shot.x, 0);
  assert.equal(session.state.fleets[charlie.id].shots.length, 1);
  assert.equal(session.state.fleets[bravo.id].shots.length, 0);
});

test('a sunk fleet is out; the last fleet afloat wins', async () => {
  const { session, alpha, bravo, charlie, a, b, c } = await startedFleet();
  for (const player of [...a, ...b, ...c]) {
    for (let i = 0; i < 12; i += 1) await answerCorrectly(session, player).catch(() => {});
  }
  await session.advance();
  await session.advance();

  const shoot = async (teamId, targetId) => {
    const team = session.teamById(teamId);
    for (const cell of session.state.fleets[targetId].ships.flatMap((ship) => ship.cells)) {
      if (session.fleetDestroyed(targetId)) break;
      session.addArsenal(teamId, 1);
      await session.attack(team.captainPlayerId, cell.x, cell.y, targetId);
    }
  };

  await shoot(alpha.id, bravo.id);
  assert.equal(session.fleetDestroyed(bravo.id), true);
  assert.equal(session.state.phase, 'battle', 'two fleets still afloat, so the battle goes on');
  assert.equal(bravo.eliminated, true);
  await expectReject(
    () => session.attack(bravo.captainPlayerId, 9, 9, alpha.id),
    'ELIMINATED',
  );
  await expectReject(() => session.attack(alpha.captainPlayerId, 9, 9, bravo.id), 'TARGET_DESTROYED');

  await shoot(alpha.id, charlie.id);
  assert.equal(session.state.phase, 'result');
  assert.equal(session.state.round.outcome.winnerId, alpha.id);
  assert.equal(session.state.round.outcome.reason, 'Fleet destroyed');
});

test('controls swap to another teammate every 30 seconds of battle', async () => {
  const { session, alpha, alphaPlayers, bravo } = await startedSquad();
  for (const player of alphaPlayers) await answerCorrectly(session, player);
  await session.advance(); // briefing
  await session.advance(); // battle
  const round = session.state.round;
  assert.ok(round.captainSwapAt, 'a swap time is set when the battle starts');

  const first = alpha.captainPlayerId;
  const bravoFirst = bravo.captainPlayerId;
  assert.equal(await session.tick(Date.now() + 10_000), false, 'nothing happens early');
  assert.equal(alpha.captainPlayerId, first);

  assert.equal(await session.tick(Date.now() + 31_000), true);
  assert.notEqual(alpha.captainPlayerId, first, 'alpha has a new captain');
  assert.notEqual(bravo.captainPlayerId, bravoFirst, 'bravo has a new captain');
  assert.ok(alphaPlayers.some((player) => player.id === alpha.captainPlayerId));
  assert.ok(Date.parse(round.captainSwapAt) > Date.now() + 25_000, 'the next swap is rescheduled');
  const view = publicProjection(session);
  assert.ok(view.round.captainSwapAt);
});

test('a side with only one player keeps its captain', async () => {
  const { session } = makeSession({ mode: MODES.SQUAD });
  const [alpha, bravo] = session.state.teams;
  const solo = session.join({ name: 'Solo', teamId: alpha.id }).player;
  session.join({ name: 'B One', teamId: bravo.id });
  session.join({ name: 'B Two', teamId: bravo.id });
  await session.advance();
  await answerCorrectly(session, solo);
  await session.advance();
  await session.advance();
  await session.tick(Date.now() + 31_000);
  assert.equal(alpha.captainPlayerId, solo.id);
});
