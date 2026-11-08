import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import { LIMITS } from '../../shared/constants.js';
import { GameError } from '../errors.js';
import { SessionRepository } from '../db/sessionRepository.js';
import { displayUrlFor, joinUrlFor, makeJoinCode } from '../util/security.js';
import { createSessionState, GameSession } from './session.js';
import { publicProjection } from './projections.js';

export class SessionManager extends EventEmitter {
  constructor({ db, config, logger }) {
    super();
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.repository = new SessionRepository(db, logger);
    this.sessions = new Map();
    this.byCode = new Map();
    this.cleanupTimer = null;
  }

  async init() {
    await this.db.migrate();
    const rows = await this.repository.listActive();
    for (const row of rows) {
      try {
        const state = this.repository.parseState(row);
        const session = new GameSession({ state, repository: this.repository, logger: this.logger });
        this.sessions.set(session.id, session);
        this.byCode.set(session.joinCode, session);
        // A restart means no browser sockets survived; persist the disconnected state.
        await this.repository.save(session.state);
      } catch (error) {
        this.logger?.error({ err: error, sessionId: row.id }, 'Failed to restore session');
      }
    }
    if (rows.length > 0) {
      this.logger?.info({ count: this.sessions.size }, 'Restored active sessions');
    }
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired().catch((error) =>
        this.logger?.warn({ err: error }, 'Session cleanup failed'),
      );
    }, 10 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  async cleanupExpired() {
    const removed = [];
    for (const session of [...this.sessions.values()]) {
      if (Date.parse(session.state.expiresAt) <= Date.now()) {
        removed.push(session.id);
        await this.remove(session.id, { expired: true });
      }
    }
    const count = await this.repository.cleanupExpired();
    if (count > 0) this.logger?.info({ count }, 'Deleted expired sessions');
    return removed;
  }

  async create({ config, baseUrl }) {
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
      });
      const session = new GameSession({
        state,
        repository: this.repository,
        logger: this.logger,
      });
      try {
        await this.repository.save(session.state);
      } catch (error) {
        lastError = error;
        this.logger?.warn({ err: error, joinCode }, 'Session insert collision');
        continue;
      }
      this.sessions.set(session.id, session);
      this.byCode.set(session.joinCode, session);
      this.emit('session', session);
      this.logger?.info(
        { sessionId: session.id, joinCode: session.joinCode, mode: session.config.mode },
        'Session created',
      );
      return session;
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
    if (!session) throw new GameError('SESSION_NOT_FOUND', 'That operation no longer exists.');
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
      players: projection.players,
      counts: projection.counts,
      join: projection.join,
      meta: projection.meta,
    };
  }

  listSummaries() {
    return [...this.sessions.values()]
      .sort((a, b) => Date.parse(b.state.createdAt) - Date.parse(a.state.createdAt))
      .map((session) => session.summary());
  }

  async remove(sessionId, { expired = false } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    if (this.byCode.get(session.joinCode) === session) this.byCode.delete(session.joinCode);
    session.emit('closed', { sessionId, expired });
    await this.repository.delete(sessionId).catch((error) => {
      this.logger?.warn({ err: error, sessionId }, 'Failed to delete session row');
    });
    session.destroy();
    this.emit('closed', { sessionId, expired });
    return true;
  }

  async closeAll() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const session of this.sessions.values()) {
      await session.flush();
      session.destroy();
    }
    this.sessions.clear();
    this.byCode.clear();
  }
}

export { LIMITS };
