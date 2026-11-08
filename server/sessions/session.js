import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  DEFAULT_CONFIG,
  LIMITS,
  MODES,
  PHASES,
  ROLES,
  TEAM_COLORS,
} from '../../shared/constants.js';
import { sessionConfigSchema } from '../../shared/schemas.js';
import { cleanText, nameKey } from '../../shared/util.js';
import { GameError, assert } from '../errors.js';
import { hashToken, makePlayerToken, shortJoinUrlFor } from '../util/security.js';

function emptyStats() {
  return {
    questionsAnswered: 0,
    correctAnswers: 0,
    incorrectAnswers: 0,
    totalResponseMs: 0,
    missilesEarned: 0,
    specialWeaponsEarned: 0,
    attacks: 0,
    hits: 0,
    misses: 0,
  };
}

function createTeam({ id, name, color, sortOrder, maxPlayers, now }) {
  return {
    id,
    name,
    color,
    sortOrder,
    maxPlayers,
    captainPlayerId: null,
    targetTeamId: null,
    missiles: 0,
    weapons: {},
    eliminated: false,
    stats: {},
    createdAt: now,
  };
}

export class GameSession extends EventEmitter {
  constructor({ state, repository, logger }) {
    super();
    this.state = state;
    this.repository = repository;
    this.logger = logger;
    this.closed = false;
    this.saveQueue = Promise.resolve();
    this.lastSaveError = null;
    this.ensureShape();

    for (const player of this.state.players) {
      player.connected = false;
      player.lastSeenAt = player.lastSeenAt || null;
    }
  }

  ensureShape() {
    this.state.teams = Array.isArray(this.state.teams) ? this.state.teams : [];
    this.state.players = Array.isArray(this.state.players) ? this.state.players : [];
    this.state.recentEvents = Array.isArray(this.state.recentEvents) ? this.state.recentEvents : [];
    this.state.version = Number(this.state.version) || 0;
    this.state.eventSeq = Number(this.state.eventSeq) || 0;
    this.state.expiresAt = this.state.expiresAt || new Date(Date.now() + LIMITS.sessionRetentionHours * 3600_000).toISOString();
  }

  get id() {
    return this.state.id;
  }

  get joinCode() {
    return this.state.joinCode;
  }

  get phase() {
    return this.state.phase;
  }

  get config() {
    return this.state.config;
  }

  playerById(playerId) {
    return this.state.players.find((player) => player.id === playerId) || null;
  }

  teamById(teamId) {
    return this.state.teams.find((team) => team.id === teamId) || null;
  }

  playersOnTeam(teamId) {
    return this.state.players.filter(
      (player) => player.teamId === teamId && player.role === ROLES.PLAYER,
    );
  }

  teamOccupancy(teamId) {
    return this.playersOnTeam(teamId).length;
  }

  recordEvent(type, payload = {}) {
    this.state.eventSeq += 1;
    const event = {
      seq: this.state.eventSeq,
      type,
      at: new Date().toISOString(),
      ...payload,
    };
    this.state.recentEvents.push(event);
    if (this.state.recentEvents.length > 80) {
      this.state.recentEvents.splice(0, this.state.recentEvents.length - 80);
    }
    this.repository.appendEvent(this.state.id, event.seq, type, payload);
    this.emit('event', event);
    return event;
  }

  bump() {
    this.state.version += 1;
    this.state.updatedAt = new Date().toISOString();
  }

  /** Broadcast immediately, persist in a serialized queue. */
  async commit() {
    this.emit('change');
    this.saveQueue = this.saveQueue
      .catch(() => {})
      .then(() => this.repository.save(this.state))
      .catch((error) => {
        this.lastSaveError = error;
        this.logger?.error({ err: error, sessionId: this.state.id }, 'Failed to persist session');
        throw new GameError(
          'PERSISTENCE_ERROR',
          'The game could not be saved. Please try again.',
        );
      });
    return this.saveQueue;
  }

  async flush() {
    await this.saveQueue.catch(() => {});
  }

  canStart() {
    if (this.state.phase !== PHASES.LOBBY) {
      return { ok: false, reason: 'The operation has already started.' };
    }
    const players = this.state.players.filter((player) => player.role === ROLES.PLAYER);
    if (players.length === 0) return { ok: false, reason: 'At least one player is required.' };

    if (this.config.mode === MODES.TEAM || this.config.mode === MODES.COOPERATIVE) {
      const empty = this.state.teams.filter((team) => this.teamOccupancy(team.id) === 0);
      if (empty.length > 0) {
        return {
          ok: false,
          reason: `Every team needs at least one player. Empty: ${empty.map((team) => team.name).join(', ')}.`,
        };
      }
    }
    return { ok: true, reason: null };
  }

  join({ name, teamId = null, asSpectator = false }) {
    assert(this.state.phase === PHASES.LOBBY, 'JOIN_CLOSED', 'Joining is closed.');
    assert(!this.config.lobbyLocked, 'LOBBY_LOCKED', 'The facilitator has locked this lobby.');
    const clean = cleanText(name, LIMITS.maxNameLength);
    assert(clean.length >= LIMITS.minNameLength, 'INVALID_NAME', 'That display name is too short.');
    const key = nameKey(clean);
    assert(
      !this.state.players.some((player) => player.nameKey === key),
      'NAME_TAKEN',
      'That display name is already in use.',
    );

    if (asSpectator) {
      assert(this.config.allowSpectators, 'SPECTATORS_OFF', 'Spectator access is disabled.');
      const spectators = this.state.players.filter((player) => player.role === ROLES.SPECTATOR);
      assert(spectators.length < 100, 'ROOM_FULL', 'The spectator list is full.');
      return this.createPlayer({ name: clean, teamId: null, role: ROLES.SPECTATOR });
    }

    const activePlayers = this.state.players.filter((player) => player.role === ROLES.PLAYER);
    assert(
      activePlayers.length < this.config.maxPlayersTotal,
      'GAME_FULL',
      'This operation is full.',
    );

    let resolvedTeamId = null;
    if (this.config.mode !== MODES.INDIVIDUAL) {
      let team = null;
      if (teamId) {
        team = this.teamById(teamId);
        assert(team, 'INVALID_TEAM', 'That team no longer exists.');
        assert(
          this.teamOccupancy(team.id) < Math.min(team.maxPlayers, this.config.maxPlayersPerTeam),
          'TEAM_FULL',
          `${team.name} is already at capacity.`,
        );
      } else {
        const candidates = this.state.teams
          .filter(
            (entry) =>
              this.teamOccupancy(entry.id) <
              Math.min(entry.maxPlayers, this.config.maxPlayersPerTeam),
          )
          .sort((a, b) => this.teamOccupancy(a.id) - this.teamOccupancy(b.id));
        team = candidates[0] || null;
      }
      assert(team, 'TEAM_FULL', 'There is no space left on any team.');
      resolvedTeamId = team.id;
    }

    return this.createPlayer({ name: clean, teamId: resolvedTeamId, role: ROLES.PLAYER });
  }

  createPlayer({ name, teamId, role }) {
    const token = makePlayerToken();
    const now = new Date().toISOString();
    const player = {
      id: `p_${crypto.randomUUID()}`,
      displayName: name,
      nameKey: nameKey(name),
      teamId: teamId || null,
      role,
      tokenHash: hashToken(token),
      connected: true,
      joinedAt: now,
      lastSeenAt: now,
      cooldownUntil: null,
      streak: 0,
      stats: emptyStats(),
    };
    this.state.players.push(player);
    const team = player.teamId ? this.teamById(player.teamId) : null;
    this.recordEvent('player_joined', {
      playerId: player.id,
      name: player.displayName,
      teamId: player.teamId,
      teamName: team?.name || null,
      role,
    });
    this.bump();
    return { player, token };
  }

  resume(token) {
    const tokenHash = hashToken(token);
    return (
      this.state.players.find((player) => player.tokenHash === tokenHash) || null
    );
  }

  async setConnected(playerId, connected) {
    const player = this.playerById(playerId);
    if (!player || player.connected === connected) return;
    player.connected = connected;
    player.lastSeenAt = new Date().toISOString();
    this.bump();
    await this.commit();
  }

  async chooseTeam(playerId, teamId) {
    assert(this.state.phase === PHASES.LOBBY, 'NOT_IN_LOBBY', 'Teams are locked.');
    assert(!this.config.lobbyLocked, 'LOBBY_LOCKED', 'The facilitator has locked the lobby.');
    assert(this.config.mode !== MODES.INDIVIDUAL, 'NOT_TEAM_MODE', 'This operation is free-for-all.');
    const player = this.playerById(playerId);
    assert(player && player.role === ROLES.PLAYER, 'PLAYER_NOT_FOUND', 'Player not found.');
    const team = this.teamById(teamId);
    assert(team, 'INVALID_TEAM', 'That team no longer exists.');
    assert(player.teamId !== team.id, 'ALREADY_ON_TEAM', 'You are already on that team.');
    assert(
      this.teamOccupancy(team.id) < Math.min(team.maxPlayers, this.config.maxPlayersPerTeam),
      'TEAM_FULL',
      `${team.name} is already at capacity.`,
    );
    const from = player.teamId ? this.teamById(player.teamId) : null;
    player.teamId = team.id;
    this.recordEvent('team_changed', {
      playerId: player.id,
      name: player.displayName,
      fromTeamId: from?.id || null,
      fromTeamName: from?.name || null,
      teamId: team.id,
      teamName: team.name,
    });
    this.bump();
    await this.commit();
  }

  async movePlayer(playerId, teamId) {
    assert(this.state.phase === PHASES.LOBBY, 'NOT_IN_LOBBY', 'Players can only be moved in the lobby.');
    const player = this.playerById(playerId);
    assert(player && player.role === ROLES.PLAYER, 'PLAYER_NOT_FOUND', 'Player not found.');
    const team = teamId ? this.teamById(teamId) : null;
    assert(team, 'INVALID_TEAM', 'That team no longer exists.');
    assert(player.teamId !== team.id, 'ALREADY_ON_TEAM', 'The player is already on that team.');
    assert(
      this.teamOccupancy(team.id) < Math.min(team.maxPlayers, this.config.maxPlayersPerTeam),
      'TEAM_FULL',
      `${team.name} is already at capacity.`,
    );
    const from = player.teamId ? this.teamById(player.teamId) : null;
    player.teamId = team.id;
    this.recordEvent('player_moved', {
      playerId: player.id,
      name: player.displayName,
      fromTeamName: from?.name || null,
      teamId: team.id,
      teamName: team.name,
    });
    this.bump();
    await this.commit();
  }

  async removePlayer(playerId) {
    const index = this.state.players.findIndex((player) => player.id === playerId);
    assert(index >= 0, 'PLAYER_NOT_FOUND', 'Player not found.');
    const [player] = this.state.players.splice(index, 1);
    const team = player.teamId ? this.teamById(player.teamId) : null;
    this.recordEvent('player_removed', {
      playerId: player.id,
      name: player.displayName,
      teamId: player.teamId,
      teamName: team?.name || null,
    });
    this.bump();
    this.emit('playerRemoved', { playerId: player.id, name: player.displayName });
    await this.commit();
    return player;
  }

  async renameTeam(teamId, name) {
    assert(this.state.phase === PHASES.LOBBY, 'NOT_IN_LOBBY', 'Team names are locked.');
    const team = this.teamById(teamId);
    assert(team, 'INVALID_TEAM', 'That team no longer exists.');
    const clean = cleanText(name, LIMITS.maxTeamNameLength);
    assert(clean.length >= 2, 'INVALID_NAME', 'Team names need at least two characters.');
    assert(
      !this.state.teams.some(
        (entry) => entry.id !== teamId && entry.name.toLowerCase() === clean.toLowerCase(),
      ),
      'TEAM_NAME_TAKEN',
      'Another team already uses that name.',
    );
    const previous = team.name;
    team.name = clean;
    this.state.config.teamNames = this.state.teams
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((entry) => entry.name);
    this.recordEvent('team_renamed', {
      teamId,
      from: previous,
      name: clean,
    });
    this.bump();
    await this.commit();
  }

  async lockLobby(locked) {
    assert(this.state.phase === PHASES.LOBBY, 'NOT_IN_LOBBY', 'The lobby is no longer active.');
    this.state.config.lobbyLocked = Boolean(locked);
    this.recordEvent('lobby_lock_changed', { locked: Boolean(locked) });
    this.bump();
    await this.commit();
  }

  async updateConfig(patch) {
    assert(this.state.phase === PHASES.LOBBY, 'NOT_IN_LOBBY', 'Settings are locked after start.');
    const merged = { ...this.state.config, ...patch };

    const structural = ['mode', 'teamCount', 'teamNames'];
    const changesStructure = structural.some(
      (key) => key in patch && JSON.stringify(patch[key]) !== JSON.stringify(this.state.config[key]),
    );
    if (changesStructure) {
      assert(
        this.state.players.length === 0,
        'PLAYERS_PRESENT',
        'Remove players before changing the game structure.',
      );
    }
    if ('maxPlayersPerTeam' in patch) {
      const largest = Math.max(
        0,
        ...this.state.teams.map((team) => this.teamOccupancy(team.id)),
      );
      assert(
        Number(patch.maxPlayersPerTeam) >= largest,
        'CAPACITY_TOO_LOW',
        'Team capacity cannot be lower than the largest current team.',
      );
    }
    if ('maxPlayersTotal' in patch) {
      assert(
        Number(patch.maxPlayersTotal) >= this.state.players.length,
        'CAPACITY_TOO_LOW',
        'Total capacity cannot be lower than the current number of players.',
      );
    }

    const parsed = sessionConfigSchema.parse(merged);
    const modeChanged = parsed.mode !== this.state.config.mode;
    const teamCountChanged = parsed.teamCount !== this.state.config.teamCount;

    this.state.config = parsed;
    if (changesStructure && (modeChanged || teamCountChanged || this.state.teams.length === 0)) {
      this.rebuildTeams();
    } else if (changesStructure && this.state.teams.length) {
      this.state.teams.forEach((team, index) => {
        team.name = parsed.teamNames[index] || team.name;
        team.maxPlayers = parsed.maxPlayersPerTeam;
      });
    }
    for (const team of this.state.teams) {
      team.maxPlayers = parsed.maxPlayersPerTeam;
    }
    this.state.name = parsed.name;
    this.recordEvent('settings_changed', { patch });
    this.bump();
    await this.commit();
  }

  rebuildTeams() {
    const now = new Date().toISOString();
    this.state.teams = this.config.teamNames.map((name, index) =>
      createTeam({
        id: `t_${crypto.randomUUID()}`,
        name,
        color: TEAM_COLORS[index % TEAM_COLORS.length],
        sortOrder: index,
        maxPlayers: this.config.maxPlayersPerTeam,
        now,
      }),
    );
    for (const player of this.state.players) player.teamId = null;
  }

  async start() {
    const check = this.canStart();
    assert(check.ok, 'CANNOT_START', check.reason || 'The operation cannot start yet.');
    this.state.phase = PHASES.MISSION_READY;
    this.state.startedAt = new Date().toISOString();
    this.state.config.lobbyLocked = true;
    this.recordEvent('mission_ready', { name: this.state.name });
    this.bump();
    await this.commit();
  }

  async returnToLobby() {
    assert(
      this.state.phase === PHASES.MISSION_READY,
      'NOT_READY',
      'The operation is not in mission-ready state.',
    );
    this.state.phase = PHASES.LOBBY;
    this.state.startedAt = null;
    this.state.config.lobbyLocked = false;
    this.recordEvent('returned_to_lobby', {});
    this.bump();
    await this.commit();
  }

  summary() {
    const players = this.state.players.filter((player) => player.role === ROLES.PLAYER);
    return {
      id: this.state.id,
      name: this.state.name,
      joinCode: this.state.joinCode,
      mode: this.config.mode,
      phase: this.state.phase,
      playerCount: players.length,
      connectedCount: players.filter((player) => player.connected).length,
      spectatorCount: this.state.players.length - players.length,
      teamCount: this.state.teams.length,
      createdAt: this.state.createdAt,
      startedAt: this.state.startedAt || null,
      expiresAt: this.state.expiresAt,
      joinUrl: shortJoinUrlFor(this.state.joinBaseUrl, this.state.joinCode),
      displayUrl: this.state.displayBaseUrl,
    };
  }

  destroy() {
    this.closed = true;
    this.removeAllListeners();
  }
}

export function createSessionState({
  id,
  joinCode,
  config,
  joinBaseUrl,
  displayBaseUrl,
  retentionHours = LIMITS.sessionRetentionHours,
}) {
  const now = new Date();
  const parsed = sessionConfigSchema.parse({ ...DEFAULT_CONFIG, ...config });
  const state = {
    schemaVersion: 1,
    id,
    joinCode,
    name: parsed.name,
    phase: PHASES.LOBBY,
    config: parsed,
    teams: [],
    players: [],
    recentEvents: [],
    eventSeq: 0,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    startedAt: null,
    endedAt: null,
    expiresAt: new Date(now.getTime() + retentionHours * 3600_000).toISOString(),
    joinBaseUrl,
    displayBaseUrl,
  };

  state.teams = parsed.teamNames.map((name, index) =>
    createTeam({
      id: `t_${crypto.randomUUID()}`,
      name,
      color: TEAM_COLORS[index % TEAM_COLORS.length],
      sortOrder: index,
      maxPlayers: parsed.maxPlayersPerTeam,
      now: state.createdAt,
    }),
  );

  return state;
}
