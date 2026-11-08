import { GameError } from '../errors.js';

/** Persistence for the live session snapshot and normalized lobby rows. */
export class SessionRepository {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  async save(state) {
    const now = new Date().toISOString();
    const configJson = JSON.stringify(state.config);
    const stateJson = JSON.stringify(state);
    const sessionParams = [
      state.id,
      state.joinCode,
      state.name,
      state.phase,
      state.config.mode,
      configJson,
      stateJson,
      state.version,
      state.createdAt,
      now,
      state.startedAt || null,
      state.endedAt || null,
      state.expiresAt,
    ];

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO sessions
          (id, join_code, name, status, mode, config, state, state_version,
           created_at, updated_at, started_at, ended_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           join_code = EXCLUDED.join_code,
           name = EXCLUDED.name,
           status = EXCLUDED.status,
           mode = EXCLUDED.mode,
           config = EXCLUDED.config,
           state = EXCLUDED.state,
           state_version = EXCLUDED.state_version,
           updated_at = EXCLUDED.updated_at,
           started_at = EXCLUDED.started_at,
           ended_at = EXCLUDED.ended_at,
           expires_at = EXCLUDED.expires_at`,
        sessionParams,
      );

      await tx.query('DELETE FROM teams WHERE session_id = $1', [state.id]);
      for (const team of state.teams) {
        await tx.query(
          `INSERT INTO teams
            (id, session_id, name, color, sort_order, max_players, captain_player_id,
             target_team_id, missiles, weapons, eliminated, stats, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14)`,
          [
            team.id,
            state.id,
            team.name,
            team.color,
            team.sortOrder,
            team.maxPlayers,
            team.captainPlayerId || null,
            team.targetTeamId || null,
            team.missiles || 0,
            JSON.stringify(team.weapons || {}),
            Boolean(team.eliminated),
            JSON.stringify(team.stats || {}),
            team.createdAt || now,
            now,
          ],
        );
      }

      await tx.query('DELETE FROM players WHERE session_id = $1', [state.id]);
      for (const player of state.players) {
        await tx.query(
          `INSERT INTO players
            (id, session_id, team_id, display_name, name_key, role, token_hash,
             connected, joined_at, last_seen_at, cooldown_until, streak, stats, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
          [
            player.id,
            state.id,
            player.teamId || null,
            player.displayName,
            player.nameKey,
            player.role,
            player.tokenHash,
            Boolean(player.connected),
            player.joinedAt,
            player.lastSeenAt || null,
            player.cooldownUntil || null,
            player.streak || 0,
            JSON.stringify(player.stats || {}),
            player.joinedAt,
          ],
        );
      }
    });
  }

  async appendEvent(sessionId, seq, type, payload = {}) {
    try {
      await this.db.query(
        `INSERT INTO session_events (session_id, seq, type, payload, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (session_id, seq) DO NOTHING`,
        [sessionId, seq, type, JSON.stringify(payload), new Date().toISOString()],
      );
    } catch (error) {
      this.logger?.warn({ err: error, sessionId, seq, type }, 'Failed to append session event');
    }
  }

  async delete(sessionId) {
    await this.db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  }

  async listActive() {
    return this.db.query(
      `SELECT * FROM sessions
       WHERE status <> 'ended' AND expires_at > now()
       ORDER BY created_at DESC`,
    );
  }

  async listAll(limit = 50) {
    return this.db.query(
      `SELECT * FROM sessions ORDER BY created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(200, Number(limit) || 50))],
    );
  }

  async findByCode(code) {
    const rows = await this.db.query(
      `SELECT * FROM sessions
       WHERE join_code = $1 AND status <> 'ended' AND expires_at > now()
       LIMIT 1`,
      [code],
    );
    return rows[0] || null;
  }

  async findById(id) {
    const rows = await this.db.query('SELECT * FROM sessions WHERE id = $1 LIMIT 1', [id]);
    return rows[0] || null;
  }

  async cleanupExpired() {
    const rows = await this.db.query(
      `DELETE FROM sessions WHERE expires_at <= now() RETURNING id`,
    );
    return rows.length;
  }

  async codeExists(code) {
    const rows = await this.db.query('SELECT 1 AS found FROM sessions WHERE join_code = $1 LIMIT 1', [
      code,
    ]);
    return rows.length > 0;
  }

  parseState(row) {
    if (!row?.state) throw new GameError('SESSION_CORRUPT', 'This session could not be restored.');
    if (typeof row.state === 'string') return JSON.parse(row.state);
    return row.state;
  }
}
