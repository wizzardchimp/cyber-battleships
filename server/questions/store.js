/**
 * Question bank storage.
 *
 * The JSON file is the source of truth. On boot the store seeds it from the
 * bundled question set if it does not exist, so a mounted Railway volume can
 * keep edits across deploys while a fresh checkout still works immediately.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GameError, LIMITS, assert } from '../game/constants.js';

const OPTION_COUNT = 4;

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function normaliseQuestion(input, usedIds = new Set()) {
  assert(input && typeof input === 'object', 'INVALID_QUESTION', 'Question payload is invalid.');

  const question = cleanText(input.question, LIMITS.maxQuestionLength);
  assert(question.length >= 8, 'INVALID_QUESTION', 'The question text is too short.');

  const options = (Array.isArray(input.options) ? input.options : []).map((option) => cleanText(option, LIMITS.maxOptionLength));
  assert(options.length === OPTION_COUNT, 'INVALID_QUESTION', 'Each question needs exactly four answers.');
  assert(options.every((option) => option.length > 0), 'INVALID_QUESTION', 'Answers cannot be empty.');

  const correctIndex = Number.parseInt(input.correctIndex, 10);
  assert(Number.isInteger(correctIndex) && correctIndex >= 0 && correctIndex < OPTION_COUNT, 'INVALID_QUESTION', 'Select which answer is correct.');

  const explanation = cleanText(input.explanation, LIMITS.maxExplanationLength);
  assert(explanation.length >= 8, 'INVALID_QUESTION', 'Add an explanation for the correct answer.');

  const difficulty = Math.min(3, Math.max(1, Number.parseInt(input.difficulty, 10) || 1));
  const topic = cleanText(input.topic, 40) || 'Cyber security';

  let id = cleanText(input.id, 40).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || usedIds.has(id)) id = `q_${crypto.randomUUID().slice(0, 8)}`;
  usedIds.add(id);

  return { id, topic, difficulty, question, options, correctIndex, explanation };
}

export class QuestionStore {
  constructor({ dataDir, seedFile }) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'questions.json');
    this.backupDir = path.join(dataDir, 'backups');
    this.seedFile = seedFile;
    this.questions = [];
    this.version = 0;
    this.load();
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });

    if (!fs.existsSync(this.file)) {
      const seed = JSON.parse(fs.readFileSync(this.seedFile, 'utf8'));
      const questions = this._normaliseList(seed.questions ?? seed);
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, updated: new Date().toISOString(), questions }, null, 2));
    }

    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.questions;
    this.questions = this._normaliseList(list);
    this.version += 1;
  }

  _normaliseList(list) {
    assert(Array.isArray(list), 'INVALID_QUESTION_FILE', 'The question file must contain an array of questions.');
    const used = new Set();
    return list.map((entry) => normaliseQuestion(entry, used)).filter(Boolean);
  }

  list() {
    return this.questions.map((question) => ({ ...question, options: [...question.options] }));
  }

  ids() {
    return this.questions.map((question) => question.id);
  }

  get(id) {
    const question = this.questions.find((entry) => entry.id === id);
    return question ? { ...question, options: [...question.options] } : null;
  }

  get count() {
    return this.questions.length;
  }

  upsert(input) {
    const id = cleanText(input?.id, 40).replace(/[^a-zA-Z0-9_-]/g, '');
    const used = new Set(this.questions.map((question) => question.id));
    if (id) used.delete(id);
    const next = normaliseQuestion(input, used);
    const index = this.questions.findIndex((question) => question.id === next.id);
    if (index >= 0) this.questions[index] = next;
    else this.questions.push(next);
    this.save();
    return { ...next, options: [...next.options] };
  }

  remove(id) {
    const before = this.questions.length;
    this.questions = this.questions.filter((question) => question.id !== id);
    assert(this.questions.length < before, 'QUESTION_NOT_FOUND', 'Question not found.');
    this.save();
  }

  replaceAll(list) {
    assert(Array.isArray(list) && list.length > 0, 'INVALID_QUESTION_FILE', 'Provide at least one question.');
    const used = new Set();
    this.questions = list.map((entry) => normaliseQuestion(entry, used));
    this.save();
  }

  save() {
    this.version += 1;
    const payload = {
      version: 1,
      updated: new Date().toISOString(),
      questions: this.questions,
    };

    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(this.file, path.join(this.backupDir, `questions-${stamp}.json`));
      const backups = fs.readdirSync(this.backupDir)
        .filter((name) => name.startsWith('questions-'))
        .sort();
      while (backups.length > 10) {
        const oldest = backups.shift();
        fs.unlinkSync(path.join(this.backupDir, oldest));
      }
    } catch {
      // First save has no previous file; ignore.
    }

    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
    fs.renameSync(temp, this.file);
  }

  assertUsable() {
    if (!this.questions.length) throw new GameError('NO_QUESTIONS', 'The question bank is empty.');
  }
}
