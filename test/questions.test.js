import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultQuestionsFor } from '../shared/questions.js';
import { parseQuestionsCsv, serializeQuestions } from '../server/questions/csv.js';

const HEADER = 'category,question,option_a,option_b,option_c,option_d,correct,explanation';

function rows(count) {
  return Array.from(
    { length: count },
    (_, index) => `Topic,Question number ${index + 1}?,Alpha,Bravo,Charlie,Delta,${'ABCD'[index % 4]},Because ${index + 1}`,
  ).join('\n');
}

test('export then import round-trips the default sets exactly', () => {
  for (const id of ['easy', 'complex']) {
    const original = defaultQuestionsFor(id);
    const csv = serializeQuestions(original);
    assert.ok(csv.startsWith('\uFEFF'), 'export starts with a byte-order mark for Excel');
    const result = parseQuestionsCsv(csv, { setId: id });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.total, original.length);
    assert.deepEqual(
      result.questions.map(({ category, prompt, options, answerIndex, explanation }) => ({
        category,
        prompt,
        options,
        answerIndex,
        explanation,
      })),
      original.map(({ category, prompt, options, answerIndex, explanation }) => ({
        category,
        prompt,
        options,
        answerIndex,
        explanation,
      })),
    );
  }
});

test('quoted cells with commas, quotes and line breaks survive', () => {
  const csv = `${HEADER}\n"Net, work","What does ""DNS"" do,\nexactly?","Maps names, to addresses",Cools servers,Encrypts disks,Blocks ads,A,"It ""resolves"" names"\n${rows(8)}`;
  const result = parseQuestionsCsv(csv);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const first = result.questions[0];
  assert.equal(first.category, 'Net, work');
  assert.equal(first.prompt, 'What does "DNS" do, exactly?');
  assert.equal(first.options[0], 'Maps names, to addresses');
  assert.equal(first.explanation, 'It "resolves" names');
});

test('semicolon and tab delimited files from other spreadsheet locales are accepted', () => {
  const body = rows(9);
  const semicolon = parseQuestionsCsv(`${HEADER.replaceAll(',', ';')}\n${body.replaceAll(',', ';')}`);
  assert.equal(semicolon.ok, true, JSON.stringify(semicolon.errors));
  assert.equal(semicolon.delimiter, ';');
  const tab = parseQuestionsCsv(`${HEADER.replaceAll(',', '\t')}\n${body.replaceAll(',', '\t')}`);
  assert.equal(tab.ok, true, JSON.stringify(tab.errors));
  assert.equal(tab.total, 9);
});

test('Windows line endings, a BOM, alias headers and number answers are fine', () => {
  const lines = ['Prompt,A,B,C,D,Answer'];
  for (let index = 0; index < 8; index += 1) lines.push(`Q${index}?,one,two,three,four,${(index % 4) + 1}`);
  const result = parseQuestionsCsv(`\uFEFF${lines.join('\r\n')}\r\n`);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.questions[0].answerIndex, 0);
  assert.equal(result.questions[2].answerIndex, 2);
  assert.equal(result.questions[0].category, 'General');
});

test('problem rows are reported by spreadsheet row and block the whole import', () => {
  const csv = [
    HEADER,
    rows(8),
    'Topic,Missing answer?,One,Two,Three,Four,,why',
    'Topic,Empty option?,One,,Three,Four,B,why',
    'Topic,Bad letter?,One,Two,Three,Four,E,why',
    'Topic,Same options?,One,One,Three,Four,A,why',
    ',,,,,,,',
  ].join('\n');
  const result = parseQuestionsCsv(csv);
  assert.equal(result.ok, false);
  assert.deepEqual(result.questions, []);
  const byRow = Object.fromEntries(result.errors.map((error) => [error.row, error.message]));
  assert.match(byRow[10], /correct must be A, B, C or D/);
  assert.match(byRow[11], /option_b is empty/);
  assert.match(byRow[12], /correct must be A, B, C or D/);
  assert.match(byRow[13], /identical/);
  assert.equal(result.warnings.some((warning) => /blank row/.test(warning.message)), true);
});

test('files with missing columns, too few questions or bad quoting are refused', () => {
  const missing = parseQuestionsCsv('question,option_a\nHi,Yes');
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0].message, /Missing columns?: .*option_b/);

  const few = parseQuestionsCsv(`${HEADER}\n${rows(3)}`);
  assert.equal(few.ok, false);
  assert.match(few.errors[0].message, /at least 8 questions/);

  const quote = parseQuestionsCsv(`${HEADER}\nTopic,"Never closed,A,B,C,D,A,x`);
  assert.equal(quote.ok, false);
  assert.match(quote.errors[0].message, /closing quote/);

  assert.equal(parseQuestionsCsv('').ok, false);
  assert.equal(parseQuestionsCsv(`${HEADER}\n`).ok, false);
});

test('duplicate questions are a warning, not a failure', () => {
  const csv = `${HEADER}\n${rows(8)}\nTopic,question number 1?,Alpha,Bravo,Charlie,Delta,A,again`;
  const result = parseQuestionsCsv(csv);
  assert.equal(result.ok, true);
  assert.equal(result.total, 9);
  assert.ok(result.warnings.some((warning) => /Same question as row 2/.test(warning.message)));
});

test('angle brackets in questions are kept as plain text', () => {
  const csv = `${HEADER}\nWeb,Which tag runs <script> code?,<script>,<style>,<div>,<p>,A,Plain text only\n${rows(8)}`;
  const result = parseQuestionsCsv(csv);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.questions[0].prompt, 'Which tag runs <script> code?');
});
