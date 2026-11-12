import assert from 'node:assert/strict';
import test from 'node:test';

import { EVENTS } from '../shared/events.js';
import { defaultQuestionsFor } from '../shared/questions.js';
import { serializeQuestions } from '../server/questions/csv.js';
import { bootTestServer, emitAck, joinPlayer, startGameScreen, waitFor } from './helpers.js';

const HEADER = 'category,question,option_a,option_b,option_c,option_d,correct,explanation';

function customCsv(count = 10, prefix = 'Custom') {
  const lines = [HEADER];
  for (let index = 0; index < count; index += 1) {
    lines.push(`Mine,${prefix} question ${index + 1}?,Red,Green,Blue,Yellow,${'ABCD'[index % 4]},Because ${index + 1}`);
  }
  return lines.join('\n');
}

function control(key) {
  return { 'x-control-key': key, 'content-type': 'application/json' };
}

async function setup(t) {
  const h = await bootTestServer();
  const screen = await startGameScreen(h.baseUrl, EVENTS);
  t.after(async () => {
    screen.socket.close();
    await h.close();
  });
  return { h, screen };
}

test('question sets are listed publicly without any answers', async (t) => {
  const { h } = await setup(t);
  const body = await fetch(`${h.baseUrl}/api/questions`).then((response) => response.json());
  assert.deepEqual(body.sets.map((set) => set.id), ['easy', 'complex']);
  assert.equal(body.sets[0].count, defaultQuestionsFor('easy').length);
  assert.equal(body.sets[1].count, defaultQuestionsFor('complex').length);
  assert.ok(!JSON.stringify(body).includes('answerIndex'));
});

test('export, import and reset all require the game screen key', async (t) => {
  const { h, screen } = await setup(t);
  const exportUrl = `${h.baseUrl}/api/questions/easy/export.csv`;

  assert.equal((await fetch(exportUrl)).status, 401);
  assert.equal((await fetch(exportUrl, { headers: { 'x-control-key': 'wrong-key-wrong-key-123' } })).status, 401);

  const body = JSON.stringify({ csv: customCsv() });
  const anonymousImport = await fetch(`${h.baseUrl}/api/questions/easy/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(anonymousImport.status, 401);
  const anonymousReset = await fetch(`${h.baseUrl}/api/questions/easy/reset`, { method: 'POST' });
  assert.equal(anonymousReset.status, 401);

  const ok = await fetch(exportUrl, { headers: { 'x-control-key': screen.key } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/csv/);
  assert.match(ok.headers.get('content-disposition'), /cyber-battleships-easy-questions\.csv/);
  const bytes = new Uint8Array(await ok.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'file starts with a UTF-8 byte-order mark');
  const text = Buffer.from(bytes).toString('utf8');
  assert.equal(text, serializeQuestions(defaultQuestionsFor('easy')));
  assert.ok(text.slice(1).startsWith('category,question,option_a'));

  assert.equal((await fetch(`${h.baseUrl}/api/questions/nope/export.csv`, { headers: { 'x-control-key': screen.key } })).status, 404);
});

test('import previews first, refuses bad files, then replaces only that set', async (t) => {
  const { h, screen } = await setup(t);
  const url = `${h.baseUrl}/api/questions/easy/import`;
  const complexBefore = h.manager.questions.questionsFor('complex').length;

  const bad = await fetch(url, {
    method: 'POST',
    headers: control(screen.key),
    body: JSON.stringify({ csv: `${customCsv(9)}\nMine,Broken?,A,B,C,D,Z,why`, dryRun: true }),
  });
  assert.equal(bad.status, 422);
  const badBody = await bad.json();
  assert.equal(badBody.error.code, 'INVALID_CSV');
  assert.match(badBody.errors[0].message, /correct must be A, B, C or D/);
  assert.equal(badBody.errors[0].row, 11);

  const dry = await fetch(url, {
    method: 'POST',
    headers: control(screen.key),
    body: JSON.stringify({ csv: customCsv(12), dryRun: true }),
  });
  assert.equal(dry.status, 200);
  const dryBody = await dry.json();
  assert.equal(dryBody.count, 12);
  assert.equal(dryBody.preview.length, 3);
  assert.equal(h.manager.questions.questionsFor('easy').length, defaultQuestionsFor('easy').length, 'preview changes nothing');

  const done = await fetch(url, {
    method: 'POST',
    headers: control(screen.key),
    body: JSON.stringify({ csv: customCsv(12) }),
  });
  assert.equal(done.status, 200);
  assert.equal(h.manager.questions.questionsFor('easy').length, 12);
  assert.equal(h.manager.questions.questionsFor('complex').length, complexBefore, 'other set untouched');
  const listed = await fetch(`${h.baseUrl}/api/questions`).then((response) => response.json());
  assert.equal(listed.sets[0].count, 12);
  assert.equal(listed.sets[0].custom, true);

  // The edit round-trips through the database.
  const rows = await h.db.query("SELECT is_custom, jsonb_array_length(questions) AS n FROM question_sets WHERE id = 'easy'");
  assert.equal(rows[0].is_custom, true);
  assert.equal(Number(rows[0].n), 12);
});

test('players are served questions from the selected set', async (t) => {
  const { h, screen } = await setup(t);
  await fetch(`${h.baseUrl}/api/questions/complex/import`, {
    method: 'POST',
    headers: control(screen.key),
    body: JSON.stringify({ csv: customCsv(10, 'Hard') }),
  });

  assert.equal((await emitAck(screen.socket, EVENTS.DISPLAY_SETTINGS, { patch: { mode: 'duel', questionSet: 'complex' } })).ok, true);
  const player = await joinPlayer(h.baseUrl, EVENTS, screen.game.joinCode, 'Reader');
  await emitAck(screen.socket, EVENTS.DISPLAY_ADVANCE, {});
  const state = await waitFor(() => player.states.latest()?.round?.me?.question && player.states.latest(), {
    label: 'player question',
  });
  player.socket.close();
  assert.match(state.round.me.question.prompt, /^Hard question \d+\?$/);
  assert.deepEqual([...state.round.me.question.options].sort(), ['Blue', 'Green', 'Red', 'Yellow']);
});

test('questions cannot be changed while a game is running', async (t) => {
  const { h, screen } = await setup(t);
  await emitAck(screen.socket, EVENTS.DISPLAY_ADVANCE, {});
  const attempt = await fetch(`${h.baseUrl}/api/questions/easy/import`, {
    method: 'POST',
    headers: control(screen.key),
    body: JSON.stringify({ csv: customCsv() }),
  });
  assert.equal(attempt.status, 409);
  const reset = await fetch(`${h.baseUrl}/api/questions/easy/reset`, {
    method: 'POST',
    headers: control(screen.key),
  });
  assert.equal(reset.status, 409);
});

test('reset restores the built-in questions', async (t) => {
  const { h, screen } = await setup(t);
  await fetch(`${h.baseUrl}/api/questions/easy/import`, {
    method: 'POST',
    headers: control(screen.key),
    body: JSON.stringify({ csv: customCsv(9) }),
  });
  assert.equal(h.manager.questions.questionsFor('easy').length, 9);

  const reset = await fetch(`${h.baseUrl}/api/questions/easy/reset`, {
    method: 'POST',
    headers: control(screen.key),
  });
  assert.equal(reset.status, 200);
  assert.equal(h.manager.questions.questionsFor('easy').length, defaultQuestionsFor('easy').length);
  assert.equal(h.manager.questions.summaries()[0].custom, false);
});

test('edited sets survive a restart and defaults are never re-seeded over them', async (t) => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-sets-'));
  const pgliteDir = path.join(root, 'pglite');

  let h = await bootTestServer({ pgliteDir });
  const screen = await startGameScreen(h.baseUrl, EVENTS);
  await fetch(`${h.baseUrl}/api/questions/complex/import`, {
    method: 'POST',
    headers: control(screen.key),
    body: JSON.stringify({ csv: customCsv(11, 'Survivor') }),
  });
  screen.socket.close();
  await h.close();

  h = await bootTestServer({ pgliteDir });
  t.after(async () => {
    await h.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const set = h.manager.questions.get('complex');
  assert.equal(set.questions.length, 11);
  assert.equal(set.custom, true);
  assert.match(set.questions[0].prompt, /^Survivor question 1\?$/);
  assert.equal(h.manager.questions.questionsFor('easy').length, defaultQuestionsFor('easy').length);
});
