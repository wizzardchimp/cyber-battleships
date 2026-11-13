import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { GameError } from '../errors.js';
import { SessionRepository } from '../db/sessionRepository.js';
import { QuestionStore } from '../questions/store.js';
import { displayUrlFor, hashToken, joinUrlFor, makeJoinCode, safeEqual } from '../util/security.js';
import { createSessionState, GameSession } from './session.js';
import { publicProjection } from './projections.js';

const SCHEMA_VERSION = 3;

/**
 * Owns the single live game. Creating a new game replaces the previous one,
 * so there is never more than one set of players on the server.
 */
export class SessionManager extends EventEmitter {
  constructor({ db, config, logger }) {
    super();
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.repository = new SessionRepository(db, logger);
    this.questions = new QuestionStore(db, logger);
    this.sessions = new Map();
    this.byCode = new Map();
    this.cleanupTimer = null;
    this.tickTimer = null;
  }

  async init() {
    await this.db.migrate();
    await this.questions.init();

    const rows = await this.repository.listActive();
    let restored = false;
    for (const row of rows) {
      try {
        const state = this.repository.parseState(row);
        // Only the newest game of the current schema survives a restart.
        if (restored || state.schemaVersion !== SCHEMA_VERSION) {
          await this.repository.delete(row.id);
          continue;
        }
        if (this.config.publicUrl) {
          // The public address may have changed since the game was saved.
          state.joinBaseUrl = joinUrlFor(this.config.publicUrl, state.joinCode);
          state.displayBaseUrl = displayUrlFor(this.config.publicUrl, state.joinCode);
        }
        const session = this.wrap(state);
        this.sessions.set(session.id, session);
        this.byCode.set(session.joinCode, session);
        await this.repository.save(session.state);
        restored = true;
      } catch (error) {
        this.logger?.error({ err: error, sessionId: row.id }, 'Failed to restore game');
      }
    }
    if (restored) this.logger?.info('Restored the active game');

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired().catch((error) =>
        this.logger?.warn({ err: error }, 'Game cleanup failed'),
      );
    }, 10 * 60 * 1000);
    this.cleanupTimer.unref?.();

    this.tickTimer = setInterval(() => {
      this.tickSessions().catch((error) => this.logger?.warn({ err: error }, 'Game tick failed'));
    }, 500);
    this.tickTimer.unref?.();
  }

  wrap(state) {
    return new GameSession({
      state,
      repository: this.repository,
      logger: this.logger,
      questions: this.questions,
      introMs: this.config.battleIntroMs,
    });
  }

  async tickSessions() {
    await Promise.allSettled([...this.sessions.values()].map((session) => session.tick()));
  }

  async cleanupExpired() {
    for (const session of [...this.sessions.values()]) {
      if (Date.parse(session.state.expiresAt) <= Date.now()) {
        await this.remove(session.id, { expired: true });
      }
    }
    const count = await this.repository.cleanupExpired();
    if (count > 0) this.logger?.info({ count }, 'Deleted expired games');
  }

  /** The one live game, or null. */
  current() {
    let newest = null;
    for (const session of this.sessions.values()) {
      if (!newest || Date.parse(session.state.createdAt) > Date.parse(newest.state.createdAt)) {
        newest = session;
      }
    }
    return newest;
  }

  keyMatches(session, key) {
    if (!session?.state.controlKeyHash || !key) return false;
    return safeEqual(session.state.controlKeyHash, hashToken(key));
  }

  /** Replace any existing game with a fresh lobby. Returns the control key once. */
  async createGame({ baseUrl, config = {} }) {
    for (const existing of [...this.sessions.values()]) {
      await this.remove(existing.id);
    }

    const controlKey = crypto.randomBytes(24).toString('base64url');
    let lastError = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const joinCode = makeJoinCode();
      if (await this.repository.codeExists(joinCode)) continue;

      const state = createSessionState({
        id: `s_${crypto.randomUUID()}`,
        joinCode,
        config,
        joinBaseUrl: joinUrlFor(baseUrl, joinCode),
        displayBaseUrl: displayUrlFor(baseUrl, joinCode),
        retentionHours: this.config.sessionRetentionHours,
        controlKeyHash: hashToken(controlKey),
      });
      const session = this.wrap(state);
      try {
        await this.repository.save(session.state);
      } catch (error) {
        lastError = error;
        this.logger?.warn({ err: error, joinCode }, 'Game insert collision');
        continue;
      }
      this.sessions.set(session.id, session);
      this.byCode.set(session.joinCode, session);
      this.emit('session', session);
      this.logger?.info({ sessionId: session.id, joinCode: session.joinCode }, 'Game created');
      return { session, controlKey };
    }
    throw new GameError('CODE_EXHAUSTED', 'Could not allocate a join code. Please try again.', lastError);
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getByCode(code) {
    return this.byCode.get(String(code || '').toUpperCase()) || null;
  }

  require(sessionId) {
    const session = this.get(sessionId);
    if (!session) throw new GameError('SESSION_NOT_FOUND', 'That game no longer exists.');
    return session;
  }

  requireByCode(code) {
    const session = this.getByCode(code);
    if (!session) throw new GameError('SESSION_NOT_FOUND', 'That join code is not valid.');
    return session;
  }

  publicSummary(session) {
    const projection = publicProjection(session);
    return {
      session: projection.session,
      teams: projection.teams,
      counts: projection.counts,
      join: projection.join,
      meta: projection.meta,
    };
  }

  async remove(sessionId, { expired = false } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    if (this.byCode.get(session.joinCode) === session) this.byCode.delete(session.joinCode);
    session.emit('closed', { sessionId, expired });
    await session.flush();
    await this.repository.delete(sessionId).catch((error) => {
      this.logger?.warn({ err: error, sessionId }, 'Failed to delete game row');
    });
    session.destroy();
    this.emit('closed', { sessionId, expired });
    return true;
  }

  async closeAll() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const session of this.sessions.values()) {
      await session.flush();
      session.destroy();
    }
    this.sessions.clear();
    this.byCode.clear();
  }
}
