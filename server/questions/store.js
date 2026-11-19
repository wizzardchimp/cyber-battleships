import crypto from 'node:crypto';

import { DEFAULT_TOPICS, MAX_TOPIC_LENGTH, OPTIONS_PER_QUESTION } from '../../shared/constants.js';
import { DEFAULT_SET_DEFS, defaultQuestionsFor, toThreeOptions } from '../../shared/questions.js';

export const VAULT_PREFIX = 'vault-';
export const MAX_VAULT_LISTS = 50;

export function cleanTopic(value) {
  const topic = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TOPIC_LENGTH);
  return topic.length >= 2 ? topic : 'Other';
}

export function isVaultId(id) {
  return typeof id === 'string' && id.startsWith(VAULT_PREFIX);
}

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
      'SELECT id, name, questions, is_custom, updated_at, topic FROM question_sets',
    );
    for (const row of rows) {
      this.sets.set(row.id, {
        id: row.id,
        name: row.name,
        questions: parseQuestions(row.questions),
        custom: Boolean(row.is_custom),
        topic: row.topic || null,
        updatedAt: new Date(row.updated_at).toISOString(),
      });
    }
    for (const def of DEFAULT_SET_DEFS) {
      if (this.sets.has(def.id)) continue;
      await this.write(def.id, def.name, defaultQuestionsFor(def.id), false, def.topic);
      this.logger?.info({ set: def.id }, 'Seeded default question set');
    }
    // Lists saved before topics existed: built-ins join Cyber and the rest go under Other.
    for (const set of [...this.sets.values()]) {
      if (set.topic) continue;
      const def = DEFAULT_SET_DEFS.find((entry) => entry.id === set.id);
      await this.write(set.id, set.name, set.questions, set.custom, def?.topic || 'Other');
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
        await this.write(set.id, set.name, defaultQuestionsFor(set.id), false, set.topic);
      } else {
        const trimmed = set.questions
          .map((question) => toThreeOptions(question))
          .filter((question) => question.options.length === OPTIONS_PER_QUESTION);
        await this.write(set.id, set.name, trimmed, true, set.topic);
      }
      this.logger?.info({ set: set.id }, 'Migrated question set to three answers');
    }
  }

  async write(id, name, questions, custom, topic = null) {
    const updatedAt = new Date().toISOString();
    await this.db.query(
      `INSERT INTO question_sets (id, name, questions, is_custom, updated_at, topic)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         questions = EXCLUDED.questions,
         is_custom = EXCLUDED.is_custom,
         updated_at = EXCLUDED.updated_at,
         topic = EXCLUDED.topic`,
      [id, name, JSON.stringify(questions), custom, updatedAt, topic],
    );
    this.sets.set(id, { id, name, questions, custom, topic, updatedAt });
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

  /** The combined pool for a selection of lists. Unknown ids are skipped. */
  questionsForMany(ids) {
    const lists = [...new Set(ids || [])].filter((id) => this.sets.has(id));
    if (!lists.length) return this.questionsFor('easy');
    return lists.flatMap((id) => this.sets.get(id).questions);
  }

  /** Default topics first, then any others in use, alphabetically. */
  topics() {
    const used = new Set([...this.sets.values()].map((set) => set.topic).filter(Boolean));
    const extra = [...used].filter((topic) => !DEFAULT_TOPICS.includes(topic)).sort((a, b) => a.localeCompare(b));
    return [...DEFAULT_TOPICS, ...extra];
  }

  summaries() {
    const builtIn = DEFAULT_SET_DEFS.map((def) => {
      const set = this.sets.get(def.id);
      return {
        id: def.id,
        name: def.name,
        count: set?.questions.length || 0,
        custom: Boolean(set?.custom),
        topic: set?.topic || def.topic,
        vault: false,
        updatedAt: set?.updatedAt || null,
      };
    });
    return [...builtIn, ...this.vaultSummaries()];
  }

  /** Lists the host has imported, newest first. They are kept for future games. */
  vaultSummaries() {
    return [...this.sets.values()]
      .filter((set) => isVaultId(set.id))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((set) => ({
        id: set.id,
        name: set.name,
        count: set.questions.length,
        custom: true,
        topic: set.topic || 'Other',
        vault: true,
        updatedAt: set.updatedAt,
      }));
  }

  vaultCount() {
    return [...this.sets.keys()].filter(isVaultId).length;
  }

  async createVault(name, questions, topic = 'Other') {
    const id = `${VAULT_PREFIX}${crypto.randomBytes(4).toString('hex')}`;
    const stamped = questions.map((question, index) => ({ ...question, id: `${id}-${index + 1}` }));
    await this.write(id, name, stamped, true, cleanTopic(topic));
    return id;
  }

  async removeVault(id) {
    if (!isVaultId(id) || !this.sets.has(id)) throw new Error(`Unknown vault list: ${id}`);
    await this.db.query('DELETE FROM question_sets WHERE id = $1', [id]);
    this.sets.delete(id);
  }

  async replace(id, questions) {
    const existing = this.sets.get(id);
    if (!existing) throw new Error(`Unknown question set: ${id}`);
    const stamped = questions.map((question, index) => ({ ...question, id: `${id}-${index + 1}` }));
    await this.write(id, existing.name, stamped, true, existing.topic);
  }

  async reset(id) {
    const def = DEFAULT_SET_DEFS.find((entry) => entry.id === id);
    if (!def) throw new Error(`Unknown question set: ${id}`);
    await this.write(id, def.name, defaultQuestionsFor(id), false, def.topic);
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
    questionsForMany: (ids) => {
      const lists = [...new Set(ids || [])].filter((id) => sets.has(id));
      return (lists.length ? lists : ['easy']).flatMap((id) => sets.get(id).questions);
    },
    topics: () => [...DEFAULT_TOPICS],
    summaries: () =>
      [...sets.values()].map((set) => ({
        id: set.id,
        name: set.name,
        count: set.questions.length,
        custom: false,
        topic: DEFAULT_SET_DEFS.find((def) => def.id === set.id)?.topic || 'Other',
        vault: false,
        updatedAt: null,
      })),
  };
}
