import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../server/game/game.js';
import { project } from '../server/game/projection.js';
import { makeGame, joinTeam, TEST_FLEET, shipCells } from './helpers.js';

function startTwoTeamGame(settings = {}) {
  const { game, store } = makeGame({ gridCount: 2, mode: 'teams', ...settings });
  const alpha = joinTeam(game, 'Alice', 't1');
  const bravo = joinTeam(game, 'Bob', 't2');
  return { game, store, alpha, bravo };
}

test('joining requires the correct code, unique name and an open team', () => {
  const { game } = makeGame({ gridCount: 2 });
  assert.throws(() => game.join({ code: 'WRONG', name: 'Alice', teamId: 't1' }), /code/i);
  const player = joinTeam(game, 'Alice', 't1');
  assert.equal(player.teamId, 't1');
  assert.throws(() => game.join({ code: game.code, name: 'Alice', teamId: 't2' }), /already in use/i);
  // A second player on a team is allowed in team mode.
  const second = joinTeam(game, 'Alicia', 't1');
  assert.equal(second.teamId, 't1');
});

test('individual mode creates one fleet slot per player in shared-target mode', () => {
  const { game } = makeGame({ gridCount: 1, mode: 'individual' });
  const alice = joinTeam(game, 'Alice');
  const bob = joinTeam(game, 'Bob');
  assert.equal(game.teams.length, 2);
  assert.equal(game.getTeam(alice.teamId).gridId, null);
  assert.equal(game.getTeam(bob.teamId).name, 'Bob');
  assert.equal(game.grids.size, 1);
  assert.ok(game.grids.has('target'));
});

test('individual mode only allows one player per fleet slot', () => {
  const { game } = makeGame({ gridCount: 2, mode: 'individual' });
  joinTeam(game, 'Alice', 't1');
  assert.throws(() => joinTeam(game, 'Bob', 't1'), /full/i);
  const bob = joinTeam(game, 'Bob', 't2');
  assert.equal(game.getTeam(bob.teamId).name, 'Bob');
});

test('start requires every team to have a player', () => {
  const { game } = makeGame({ gridCount: 2 });
  joinTeam(game, 'Alice', 't1');
  assert.throws(() => game.start(), /BRAVO|every team/i);
  joinTeam(game, 'Bob', 't2');
  game.start();
  assert.equal(game.phase, 'question');
  assert.equal(game.teams.length, 2);
  assert.equal(game.grids.size, 2);
});

test('answers award points and a missile to the first correct team', () => {
  const { game, alpha } = startTwoTeamGame();
  game.start();
  const question = game.round.questions[0].question;
  const result = game.submitAnswer(alpha.id, game.round.questions[0].questionId, question.correctIndex);
  assert.equal(result.correct, true);
  assert.equal(result.awarded, true);
  const team = game.getTeam(alpha.teamId);
  assert.equal(team.missiles, 3);
  assert.equal(team.score, 15); // 10 correct + 5 first
  assert.equal(game.round.questions[0].firstCorrectTeamId, alpha.teamId);
});

test('incorrect answers lock after the configured attempts', () => {
  const { game, alpha } = startTwoTeamGame({ maxAttempts: 2 });
  game.start();
  const wrong = (game.round.questions[0].question.correctIndex + 1) % 4;
  const first = game.submitAnswer(alpha.id, game.round.questions[0].questionId, wrong);
  assert.equal(first.correct, false);
  assert.equal(first.locked, false);
  assert.equal(first.attempts, 1);

  const second = game.submitAnswer(alpha.id, game.round.questions[0].questionId, wrong);
  assert.equal(second.locked, true);
  assert.throws(
    () => game.submitAnswer(alpha.id, game.round.questions[0].questionId, game.round.questions[0].question.correctIndex),
    /locked/i,
  );
});

test('award mode all gives every correct answer a missile', () => {
  const { game, alpha, bravo } = startTwoTeamGame({ awardMode: 'all' });
  game.start();
  const correct = game.round.questions[0].question.correctIndex;
  const a = game.submitAnswer(alpha.id, game.round.questions[0].questionId, correct);
  const b = game.submitAnswer(bravo.id, game.round.questions[0].questionId, correct);
  assert.equal(a.awarded, true);
  assert.equal(b.awarded, true);
  assert.equal(game.getTeam(alpha.teamId).missiles, 3);
  assert.equal(game.getTeam(bravo.teamId).missiles, 3);
  // Only the first correct answer gets the first bonus.
  assert.equal(game.getTeam(alpha.teamId).score, 15);
  assert.equal(game.getTeam(bravo.teamId).score, 10);
});

test('a missile cap blocks further awards', () => {
  const { game, alpha } = startTwoTeamGame({ awardMode: 'all', missileCap: 1 });
  game.start();
  const correct = game.round.questions[0].question.correctIndex;
  game.submitAnswer(alpha.id, game.round.questions[0].questionId, correct);
  assert.equal(game.getTeam(alpha.teamId).missiles, 3);
  game.revealQuestion();
  game.enterBattle();
  game.nextQuestion();
  game.submitAnswer(alpha.id, game.round.questions[0].questionId, game.round.questions[0].question.correctIndex);
  assert.equal(game.getTeam(alpha.teamId).missiles, 3);
});

test('firing consumes a missile, scores a hit and rejects repeat shots', () => {
  const { game, alpha } = startTwoTeamGame();
  game.start();
  game.revealQuestion();
  game.enterBattle();
  game.hostAwardMissiles(alpha.teamId, 1);

  const team = game.getTeam(alpha.teamId);
  const target = [...game.grids.values()].find((grid) => grid.ownerTeamId !== team.id);
  const cell = target.ships[0].cells[0];
  const scoreBefore = team.score;

  const shot = game.fire(alpha.id, target.id, cell.col, cell.row);
  assert.equal(shot.hit, true);
  assert.equal(team.missiles, 0);
  assert.equal(team.stats.missilesFired, 1);
  assert.equal(team.score, scoreBefore + 25);
  assert.equal(game.shots.length, 1);

  assert.throws(() => game.fire(alpha.id, target.id, 9, 9), /no missiles/i);
});

test('players cannot fire at their own fleet', () => {
  const { game, alpha } = startTwoTeamGame();
  game.start();
  game.revealQuestion();
  game.enterBattle();
  game.hostAwardMissiles(alpha.teamId, 3);
  const team = game.getTeam(alpha.teamId);
  assert.throws(() => game.fire(alpha.id, team.gridId, 0, 0), /own fleet/i);
});

test('shared target mode lets every team attack the single grid', () => {
  const { game } = makeGame({ gridCount: 1, mode: 'teams' });
  const teamA = game.join({ code: game.code, name: 'Alice' });
  const teamB = game.join({ code: game.code, name: 'Bob' });
  game.start();
  game.revealQuestion();
  game.enterBattle();
  game.hostAwardMissiles(teamA.teamId, 2);
  game.hostAwardMissiles(teamB.teamId, 2);
  const shot = game.fire(teamA.id, 'target', 0, 0);
  assert.ok(['hit', 'miss'].includes(shot.hit ? 'hit' : 'miss'));
  assert.equal(game.getTeam(teamB.teamId).missiles, 2);
});

test('destroying the final fleet ends the game and picks the survivor', async () => {
  const { game, alpha, bravo } = startTwoTeamGame();
  game.setShips('g1', TEST_FLEET);
  game.setShips('g2', TEST_FLEET);
  game.start();
  game.revealQuestion();
  game.enterBattle();
  game.hostAwardMissiles(alpha.teamId, 30);

  for (const cell of shipCells()) {
    if (game.ending) break;
    game.fire(alpha.id, 'g2', cell.col, cell.row);
  }

  assert.equal(game.getTeam(bravo.teamId).eliminated, true);
  assert.equal(game.phase, 'battle');
  await new Promise((resolve) => setTimeout(resolve, 2900));
  assert.equal(game.phase, 'ended');
  assert.equal(game.winnerTeamId, alpha.teamId);
  assert.equal(game.final.winnerName, 'ALPHA');
});

test('destroying the shared target ends the game with the top scorer winning', async () => {
  const { game } = makeGame({ gridCount: 1, mode: 'teams' });
  const alice = game.join({ code: game.code, name: 'Alice' });
  game.join({ code: game.code, name: 'Bob' });
  game.setShips('target', TEST_FLEET);
  game.start();
  game.revealQuestion();
  game.enterBattle();
  game.hostAwardMissiles(alice.teamId, 30);
  for (const cell of shipCells()) {
    if (game.ending) break;
    game.fire(alice.id, 'target', cell.col, cell.row);
  }
  await new Promise((resolve) => setTimeout(resolve, 2900));
  assert.equal(game.phase, 'ended');
  assert.equal(game.winnerTeamId, alice.teamId);
  assert.equal(game.final.targetDestroyed, true);
});

test('projection hides ship cells and the answer key from the projector', () => {
  const { game, alpha } = startTwoTeamGame();
  game.start();
  const display = project(game, 'display');
  const host = project(game, 'host');
  const player = project(game, 'player', alpha.id);

  assert.equal(display.round.questions[0].correctIndex, undefined);
  assert.equal(host.round.questions[0].correctIndex, game.round.questions[0].question.correctIndex);
  assert.equal(display.teams.length, 2);

  const hostGrid = host.grids.find((grid) => grid.ownerTeamId === alpha.teamId);
  const shipCell = hostGrid.ships.find((ship) => !ship.sunk).cells[0];
  const displayGrid = display.grids.find((grid) => grid.id === hostGrid.id);
  assert.equal(displayGrid.cells[shipCell.row][shipCell.col], 'unknown');
  assert.equal(displayGrid.ships[0].cells, undefined);

  const ownGrid = player.grids.find((grid) => grid.id === player.me.ownGridId);
  assert.equal(ownGrid.cells[shipCell.row][shipCell.col], 'ship');

  const opponentGrid = player.grids.find((grid) => grid.id !== player.me.ownGridId);
  const opponentShips = project(game, 'host').grids.find((grid) => grid.id === opponentGrid.id).ships;
  const opponentCell = opponentShips[0].cells[0];
  assert.equal(opponentGrid.cells[opponentCell.row][opponentCell.col], 'unknown');

  game.revealQuestion();
  const revealed = project(game, 'display');
  assert.equal(revealed.round.questions[0].correctIndex, game.round.questions[0].question.correctIndex);
  assert.ok(revealed.round.questions[0].explanation.length > 10);
});

test('team rename and player moves update labels and capacity', () => {
  const { game } = makeGame({ gridCount: 2 });
  game.setTeamName('t1', 'RED CELL');
  assert.equal(game.getTeam('t1').name, 'RED CELL');
  assert.equal(game.grids.get('g1').label, 'RED CELL');
  const alice = joinTeam(game, 'Alice', 't1');
  const bob = joinTeam(game, 'Bob', 't2');
  game.movePlayer(bob.id, 't1');
  assert.equal(game.getTeam('t1').players.length, 2);
  assert.equal(game.getTeam('t2').players.length, 0);
  assert.equal(game.getTeam(bob.teamId).id, 't1');
  assert.ok(alice);
});

test('new game clears players and rotates the code', () => {
  const { game } = startTwoTeamGame();
  const oldCode = game.code;
  game.newGame();
  assert.equal(game.phase, 'lobby');
  assert.equal(game.players.size, 0);
  assert.notEqual(game.code, oldCode);
  assert.equal(game.teams.length, 2);
  assert.ok(game.grids.get('g1').ships.length === 0);
});
