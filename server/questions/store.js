import { OPTIONS_PER_QUESTION } from '../../shared/constants.js';
import { DEFAULT_SET_DEFS, defaultQuestionsFor, toThreeOptions } from '../../shared/questions.js';

function parseQuestions(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * The editable question sets. They live in PostgreSQL and are cached in memory,
 * so a game never waits on the database to issue a question.
 */
export class QuestionStore {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
    this.sets = new Map();
  }

  async init() {
    const rows = await this.db.query(
      'SELECT id, name, questions, is_custom, updated_at FROM question_sets',
    );
    for (const row of rows) {
      this.sets.set(row.id, {
        id: row.id,
        name: row.name,
        questions: parseQuestions(row.questions),
        custom: Boolean(row.is_custom),
        updatedAt: new Date(row.updated_at).toISOString(),
      });
    }
    for (const def of DEFAULT_SET_DEFS) {
      if (this.sets.has(def.id)) continue;
      await this.write(def.id, def.name, defaultQuestionsFor(def.id), false);
      this.logger?.info({ set: def.id }, 'Seeded default question set');
    }
    await this.migrateToThreeOptions();
  }

  /**
   * Older versions stored four answers per question. Built-in sets are simply
   * restored from the new defaults; edited sets keep their questions but are
   * trimmed to the correct answer plus two wrong ones.
   */
  async migrateToThreeOptions() {
    for (const set of [...this.sets.values()]) {
      const stale = set.questions.some((question) => question.options?.length !== OPTIONS_PER_QUESTION);
      if (!stale) continue;
      if (!set.custom) {
        await this.write(set.id, set.name, defaultQuestionsFor(set.id), false);
      } else {
        const trimmed = set.questions
          .map((question) => toThreeOptions(question))
          .filter((question) => question.options.length === OPTIONS_PER_QUESTION);
        await this.write(set.id, set.name, trimmed, true);
      }
      this.logger?.info({ set: set.id }, 'Migrated question set to three answers');
    }
  }

  async write(id, name, questions, custom) {
    const updatedAt = new Date().toISOString();
    await this.db.query(
      `INSERT INTO question_sets (id, name, questions, is_custom, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         questions = EXCLUDED.questions,
         is_custom = EXCLUDED.is_custom,
         updated_at = EXCLUDED.updated_at`,
      [id, name, JSON.stringify(questions), custom, updatedAt],
    );
    this.sets.set(id, { id, name, questions, custom, updatedAt });
  }

  has(id) {
    return this.sets.has(id);
  }

  get(id) {
    return this.sets.get(id) || null;
  }

  questionsFor(id) {
    return this.sets.get(id)?.questions || this.sets.get('easy')?.questions || [];
  }

  summaries() {
    return DEFAULT_SET_DEFS.map((def) => {
      const set = this.sets.get(def.id);
      return {
        id: def.id,
        name: set?.name || def.name,
        count: set?.questions.length || 0,
        custom: Boolean(set?.custom),
        updatedAt: set?.updatedAt || null,
      };
    });
  }

  async replace(id, questions) {
    const existing = this.sets.get(id);
    if (!existing) throw new Error(`Unknown question set: ${id}`);
    const stamped = questions.map((question, index) => ({ ...question, id: `${id}-${index + 1}` }));
    await this.write(id, existing.name, stamped, true);
  }

  async reset(id) {
    const def = DEFAULT_SET_DEFS.find((entry) => entry.id === id);
    if (!def) throw new Error(`Unknown question set: ${id}`);
    await this.write(id, def.name, defaultQuestionsFor(id), false);
  }
}

/** Database-free provider for unit tests and tools. */
export function createStaticQuestions(overrides = {}) {
  const sets = new Map();
  for (const def of DEFAULT_SET_DEFS) {
    sets.set(def.id, {
      id: def.id,
      name: def.name,
      questions: overrides[def.id] || defaultQuestionsFor(def.id),
    });
  }
  return {
    has: (id) => sets.has(id),
    get: (id) => sets.get(id) || null,
    questionsFor: (id) => sets.get(id)?.questions || sets.get('easy').questions,
    summaries: () =>
      [...sets.values()].map((set) => ({
        id: set.id,
        name: set.name,
        count: set.questions.length,
        custom: false,
        updatedAt: null,
      })),
  };
}
