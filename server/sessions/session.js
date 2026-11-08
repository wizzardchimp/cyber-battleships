import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  DEFAULT_CONFIG,
  LIMITS,
  MIN_ATTACK_SECONDS,
  MODES,
  PHASES,
  ROLES,
  ROUND_REVEAL_SECONDS,
  TEAM_COLORS,
  missileRewardFor,
} from '../../shared/constants.js';
import { pickQuestion } from '../../shared/questions.js';
import { sessionConfigSchema } from '../../shared/schemas.js';
import { cleanText, nameKey } from '../../shared/util.js';
import { GameError, assert } from '../errors.js';
import { hashToken, makePlayerToken, shortJoinUrlFor } from '../util/security.js';
import {
  CPU_ID,
  CPU_NAME,
  attackId,
  buildCombatants,
  cellKey,
  ensureScore,
  ensureLateCombatant,
  makeFleet,
  makeQuestionState,
  makeRound,
  ownerForPlayer,
  ownerName,
} from './round.js';

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
    this.ticking = false;
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

    // Stage 2 round state. Older snapshots simply gain an empty shape.
    this.state.schemaVersion = Math.max(2, Number(this.state.schemaVersion) || 0);
    this.state.round = this.state.round || null;
    this.state.fleets = this.state.fleets && typeof this.state.fleets === 'object' ? this.state.fleets : {};
    this.state.arsenal = this.state.arsenal && typeof this.state.arsenal === 'object' ? this.state.arsenal : {};
    this.state.scores = this.state.scores && typeof this.state.scores === 'object' ? this.state.scores : {};
    this.state.usedQuestions = Array.isArray(this.state.usedQuestions) ? this.state.usedQuestions : [];
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
    const phase = this.state.phase;
    const inLobby = phase === PHASES.LOBBY;
    const lateOpen =
      this.config.allowLateJoin &&
      [PHASES.MISSION_READY, PHASES.QUESTION, PHASES.ATTACK, PHASES.ROUND_OVER].includes(phase);
    assert(inLobby || lateOpen, 'JOIN_CLOSED', 'Joining is closed.');
    if (inLobby) {
      assert(!this.config.lobbyLocked, 'LOBBY_LOCKED', 'The facilitator has locked this lobby.');
    }
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

    const result = this.createPlayer({ name: clean, teamId: resolvedTeamId, role: ROLES.PLAYER });
    if (!inLobby && this.state.round && [PHASES.QUESTION, PHASES.ATTACK].includes(phase)) {
      ensureLateCombatant(this.state, result.player);
      this.bump();
    }
    return result;
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

  // ------------------------------------------------------------- stage 2

  playersInRound() {
    return this.state.players.filter((player) => player.role === ROLES.PLAYER);
  }

  arsenalFor(ownerId) {
    return Number(this.state.arsenal[ownerId]) || 0;
  }

  setArsenal(ownerId, value) {
    const next = Math.max(0, Number(value) || 0);
    this.state.arsenal[ownerId] = next;
    const team = this.state.teams.find((entry) => entry.id === ownerId);
    if (team) team.missiles = next;
    return next;
  }

  addArsenal(ownerId, amount) {
    return this.setArsenal(ownerId, this.arsenalFor(ownerId) + Number(amount || 0));
  }

  activeCombatant(ownerId) {
    return this.state.round?.combatants?.find((entry) => entry.id === ownerId) || null;
  }

  /** Start a fresh round of questions and attacks. */
  beginRound({ reset = false } = {}) {
    const now = Date.now();
    const gridSize = this.config.gridSize;
    const number = reset ? 1 : (this.state.round?.number || 0) + 1;

    if (reset) {
      this.state.usedQuestions = [];
      this.state.scores = {};
      this.state.fleets = {};
      this.state.arsenal = {};
    }

    const combatants = buildCombatants(this.state);
    this.state.round = makeRound({
      state: this.state,
      number,
      now,
      quizEndsAt: now + this.config.roundMinutes * 60_000,
      combatants,
    });

    for (const combatant of combatants) {
      this.state.fleets[combatant.id] = makeFleet(gridSize);
      ensureScore(this.state, combatant.id);
      if (reset || !this.config.ammoCarryOver || this.state.arsenal[combatant.id] === undefined) {
        this.setArsenal(combatant.id, 0);
      } else {
        this.setArsenal(combatant.id, this.arsenalFor(combatant.id));
      }
    }

    // Drop arsenal entries for teams/players no longer in the round.
    const liveIds = new Set(combatants.map((combatant) => combatant.id));
    for (const ownerId of Object.keys(this.state.arsenal)) {
      if (!liveIds.has(ownerId)) delete this.state.arsenal[ownerId];
    }

    this.state.phase = PHASES.QUESTION;
    this.state.round.phase = PHASES.QUESTION;
    this.state.endedAt = null;
    this.startQuestion(now);
    this.recordEvent('round_started', { round: number });
    this.bump();
  }

  startQuestion(now = Date.now()) {
    const round = this.state.round;
    assert(round, 'NOT_IN_ROUND', 'No round is active.');
    const question = pickQuestion({
      difficulty: this.config.difficulty,
      ageGroup: this.config.ageGroup,
      used: this.state.usedQuestions,
    });
    if (!question) return;
    round.questionNumber += 1;
    round.answers = {};
    round.question = makeQuestionState(
      question,
      round.questionNumber,
      now,
      now + this.config.questionTimer * 1000,
    );
    if (!this.state.usedQuestions.includes(question.id)) {
      this.state.usedQuestions.push(question.id);
    }
    // Reset the used list when the bank is exhausted so long drills keep going.
    if (this.state.usedQuestions.length >= 32) this.state.usedQuestions = [];
  }

  allPlayersAnswered() {
    const players = this.playersInRound();
    const answered = this.state.round?.answers || {};
    if (players.length === 0) return false;
    return players.every((player) => answered[player.id]);
  }

  revealQuestion(now = Date.now()) {
    const question = this.state.round?.question;
    if (!question || question.revealedAt) return false;
    question.revealedAt = new Date(now).toISOString();
    question.revealUntil = new Date(now + ROUND_REVEAL_SECONDS * 1000).toISOString();
    this.recordEvent('question_revealed', {
      round: this.state.round.number,
      questionNumber: question.number,
      answerCount: Object.keys(this.state.round.answers).length,
    });
    this.bump();
    return true;
  }

  enterAttack(now = Date.now()) {
    const round = this.state.round;
    assert(round, 'NOT_IN_ROUND', 'No round is active.');
    round.lastQuestion = round.question;
    round.question = null;
    round.phase = PHASES.ATTACK;
    round.attackStartedAt = new Date(now).toISOString();
    round.attackEndsAt = new Date(
      now + Math.max(MIN_ATTACK_SECONDS, this.config.tacticalSeconds) * 1000,
    ).toISOString();
    this.state.phase = PHASES.ATTACK;
    this.recordEvent('attack_phase_started', { round: round.number });
    this.bump();
  }

  finishRound(now = Date.now()) {
    const round = this.state.round;
    assert(round, 'NOT_IN_ROUND', 'No round is active.');
    round.phase = PHASES.ROUND_OVER;
    round.endedAt = new Date(now).toISOString();
    round.question = null;
    this.state.phase = PHASES.ROUND_OVER;

    const results = round.combatants
      .map((combatant) => {
        const score = ensureScore(this.state, combatant.id);
        const fleet = this.state.fleets[combatant.id];
        const shipsTotal = fleet?.ships?.length || 0;
        const shipsSunk = fleet?.ships?.filter((ship) => ship.sunk).length || 0;
        return {
          id: combatant.id,
          name: combatant.name,
          color: combatant.color,
          kind: combatant.kind,
          points: score.points,
          hits: score.hits,
          misses: score.misses,
          sunk: score.sunk,
          correct: score.correct,
          answered: score.answered,
          missiles: this.arsenalFor(combatant.id),
          shipsTotal,
          shipsSunk,
          shipsRemaining: shipsTotal - shipsSunk,
          eliminated: shipsTotal > 0 && shipsSunk >= shipsTotal,
        };
      })
      .sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.hits !== a.hits) return b.hits - a.hits;
        return a.name.localeCompare(b.name);
      });

    round.results = results;

    const cpu = results.find((entry) => entry.id === CPU_ID);
    const human = results.find((entry) => entry.kind === 'team' || entry.kind === 'player');
    let winner = results[0] || null;
    let reason = 'Highest score';
    if (this.config.mode === MODES.COOPERATIVE && human) {
      const breached = Boolean(cpu?.eliminated);
      winner = breached ? human : { id: CPU_ID, name: CPU_NAME, color: '#c084fc', kind: 'cpu' };
      reason = breached ? 'Firewall breached' : 'Firewall held';
    }

    round.outcome = winner
      ? {
          winnerId: winner.id,
          winnerName: winner.name,
          winnerColor: winner.color,
          reason,
        }
      : { winnerId: null, winnerName: 'No winner', winnerColor: '#63899d', reason };

    this.recordEvent('round_over', {
      round: round.number,
      winnerName: round.outcome.winnerName,
      reason,
    });
    this.bump();
  }

  /** Player submits one multiple-choice answer. */
  async answer(playerId, questionNumber, optionIndex) {
    assert(this.state.phase === PHASES.QUESTION, 'NOT_QUESTION_PHASE', 'No question is open.');
    const round = this.state.round;
    const question = round?.question;
    assert(question && !question.revealedAt, 'QUESTION_CLOSED', 'That question has closed.');
    assert(
      Number(questionNumber) === question.number,
      'QUESTION_CHANGED',
      'A newer question is already open.',
    );

    const player = this.playerById(playerId);
    assert(player && player.role === ROLES.PLAYER, 'PLAYER_NOT_FOUND', 'Players only.');
    assert(!round.answers[playerId], 'ALREADY_ANSWERED', 'You already answered this question.');

    const index = Number(optionIndex);
    assert(
      Number.isInteger(index) && index >= 0 && index < question.options.length,
      'INVALID_ANSWER',
      'Choose one of the listed answers.',
    );

    const ownerId = ownerForPlayer(this.state, player);
    assert(ownerId, 'NO_TEAM', 'Join a team before answering.');

    const now = Date.now();
    const elapsedMs = Math.max(0, now - Date.parse(question.startedAt));
    const elapsedSeconds = elapsedMs / 1000;
    const correct = index === question.answerIndex;
    const reward = correct ? missileRewardFor(elapsedSeconds) : 0;

    round.answers[playerId] = {
      questionNumber: question.number,
      optionIndex: index,
      at: new Date(now).toISOString(),
      ms: elapsedMs,
      correct,
      reward,
      ownerId,
    };

    const score = ensureScore(this.state, ownerId);
    score.answered += 1;
    player.stats.questionsAnswered = (player.stats.questionsAnswered || 0) + 1;
    player.stats.totalResponseMs = (player.stats.totalResponseMs || 0) + elapsedMs;

    if (correct) {
      score.correct += 1;
      score.points += 10;
      score.missilesEarned += reward;
      player.stats.correctAnswers = (player.stats.correctAnswers || 0) + 1;
      player.stats.missilesEarned = (player.stats.missilesEarned || 0) + reward;
      player.streak = (player.streak || 0) + 1;
      this.addArsenal(ownerId, reward);
    } else {
      player.stats.incorrectAnswers = (player.stats.incorrectAnswers || 0) + 1;
      player.streak = 0;
    }

    this.bump();
    if (this.allPlayersAnswered()) this.revealQuestion(now);
    await this.commit();

    return {
      correct,
      reward,
      missiles: this.arsenalFor(ownerId),
      ownerId,
    };
  }

  /** Fire one missile at the player's assigned target grid. */
  async attack(playerId, x, y) {
    assert(this.state.phase === PHASES.ATTACK, 'NOT_ATTACK_PHASE', 'The attack phase is closed.');
    const round = this.state.round;
    const player = this.playerById(playerId);
    assert(player && player.role === ROLES.PLAYER, 'PLAYER_NOT_FOUND', 'Players only.');
    const ownerId = ownerForPlayer(this.state, player);
    const combatant = this.activeCombatant(ownerId);
    assert(combatant, 'NO_TEAM', 'Your team is not in this round.');
    assert(combatant.targetId, 'NO_TARGET', 'No target is assigned.');
    assert(combatant.targetId !== ownerId, 'NO_TARGET', 'You cannot attack your own grid.');

    const targetFleet = this.state.fleets[combatant.targetId];
    assert(targetFleet, 'NO_TARGET', 'That target grid is unavailable.');
    const cx = Number(x);
    const cy = Number(y);
    assert(
      Number.isInteger(cx) &&
        Number.isInteger(cy) &&
        cx >= 0 &&
        cy >= 0 &&
        cx < targetFleet.gridSize &&
        cy < targetFleet.gridSize,
      'INVALID_COORDINATE',
      'Choose a cell inside the target grid.',
    );
    assert(this.arsenalFor(ownerId) > 0, 'NO_MISSILES', 'No missiles available. Answer questions to earn more.');

    const used = round.attacks.filter((entry) => entry.ownerId === ownerId).length;
    assert(
      used < this.config.maxAttacksPerTeam,
      'ATTACK_LIMIT',
      `You have used all ${this.config.maxAttacksPerTeam} attacks this round.`,
    );
    assert(
      !round.attacks.some(
        (entry) =>
          entry.ownerId === ownerId &&
          entry.targetId === combatant.targetId &&
          entry.x === cx &&
          entry.y === cy,
      ),
      'CELL_ALREADY_TARGETED',
      'That cell has already been targeted.',
    );

    this.addArsenal(ownerId, -1);
    const key = cellKey(cx, cy);
    const ship = targetFleet.ships.find((entry) =>
      entry.cells.some((cell) => cellKey(cell.x, cell.y) === key),
    );
    const hit = Boolean(ship);
    const now = Date.now();
    let sunkShip = null;

    if (ship) {
      ship.hits += 1;
      if (!ship.sunk && ship.hits >= ship.length) {
        ship.sunk = true;
        sunkShip = ship.name;
      }
    }

    targetFleet.shots.push({
      x: cx,
      y: cy,
      by: ownerId,
      hit,
      at: new Date(now).toISOString(),
      round: round.number,
    });
    round.attacks.push({
      id: attackId(),
      ownerId,
      targetId: combatant.targetId,
      x: cx,
      y: cy,
      hit,
      sunkShip,
      at: new Date(now).toISOString(),
      round: round.number,
    });

    const score = ensureScore(this.state, ownerId);
    if (hit) {
      score.hits += 1;
      score.points += 25;
      player.stats.attacks = (player.stats.attacks || 0) + 1;
      player.stats.hits = (player.stats.hits || 0) + 1;
      if (sunkShip) {
        score.sunk += 1;
        score.points += 50;
        this.recordEvent('ship_sunk', {
          round: round.number,
          ownerName: ownerName(this.state, ownerId),
          targetName: ownerName(this.state, combatant.targetId),
          shipName: sunkShip,
        });
      }
    } else {
      score.misses += 1;
      player.stats.attacks = (player.stats.attacks || 0) + 1;
      player.stats.misses = (player.stats.misses || 0) + 1;
    }

    this.bump();
    await this.commit();

    return {
      hit,
      sunk: Boolean(sunkShip),
      shipName: sunkShip,
      missiles: this.arsenalFor(ownerId),
      attacksUsed: used + 1,
      attacksLimit: this.config.maxAttacksPerTeam,
    };
  }

  /** Tick timers forward. Returns true when the phase changed. */
  async tick(now = Date.now()) {
    if (this.closed) return false;
    if (![PHASES.QUESTION, PHASES.ATTACK].includes(this.state.phase)) return false;
    if (this.ticking) return false;
    this.ticking = true;
    let changed = false;
    try {
      const round = this.state.round;
      if (!round) return false;

      if (this.state.phase === PHASES.QUESTION) {
        const question = round.question;
        if (question && !question.revealedAt) {
          const timedOut = now >= Date.parse(question.endsAt);
          if (timedOut || this.allPlayersAnswered()) {
            changed = this.revealQuestion(now) || changed;
          }
        } else if (question && question.revealedAt && now >= Date.parse(question.revealUntil)) {
          if (now >= Date.parse(round.quizEndsAt)) {
            this.enterAttack(now);
          } else {
            this.startQuestion(now);
          }
          changed = true;
        } else if (!question && now >= Date.parse(round.quizEndsAt)) {
          this.enterAttack(now);
          changed = true;
        }
      } else if (this.state.phase === PHASES.ATTACK) {
        if (now >= Date.parse(round.attackEndsAt)) {
          this.finishRound(now);
          changed = true;
        }
      }

      if (changed) await this.commit();
      return changed;
    } catch (error) {
      this.logger?.error({ err: error, sessionId: this.state.id }, 'Round tick failed');
      return false;
    } finally {
      this.ticking = false;
    }
  }

  async start({ force = false } = {}) {
    const phase = this.state.phase;
    if (phase === PHASES.LOBBY) {
      if (!force) {
        const check = this.canStart();
        assert(check.ok, 'CANNOT_START', check.reason || 'The operation cannot start yet.');
      }
      this.state.config.lobbyLocked = true;
      this.state.startedAt = new Date().toISOString();
      this.beginRound({ reset: true });
      await this.commit();
      return;
    }
    if (phase === PHASES.MISSION_READY || phase === PHASES.ROUND_OVER) {
      this.beginRound({ reset: false });
      await this.commit();
      return;
    }
    throw new GameError('ALREADY_STARTED', 'A round is already in progress.');
  }

  /** Host control: advance the current phase or launch the next round. */
  async advance() {
    const phase = this.state.phase;
    if (phase === PHASES.LOBBY || phase === PHASES.MISSION_READY) {
      await this.start({ force: true });
      return;
    }
    if (phase === PHASES.QUESTION) {
      this.enterAttack();
      await this.commit();
      return;
    }
    if (phase === PHASES.ATTACK) {
      this.finishRound();
      await this.commit();
      return;
    }
    if (phase === PHASES.ROUND_OVER) {
      this.beginRound({ reset: false });
      await this.commit();
      return;
    }
    throw new GameError('NOT_IN_ROUND', 'There is no active round to advance.');
  }

  /** Host control: end the current round immediately. */
  async endRound() {
    const phase = this.state.phase;
    if (phase === PHASES.QUESTION || phase === PHASES.ATTACK) {
      this.finishRound();
      await this.commit();
      return;
    }
    throw new GameError('NOT_IN_ROUND', 'There is no active round to end.');
  }

  async returnToLobby() {
    assert(
      [PHASES.MISSION_READY, PHASES.QUESTION, PHASES.ATTACK, PHASES.ROUND_OVER].includes(
        this.state.phase,
      ),
      'NOT_READY',
      'The operation is not in a running round.',
    );
    this.state.phase = PHASES.LOBBY;
    this.state.startedAt = null;
    this.state.endedAt = null;
    this.state.config.lobbyLocked = false;
    this.state.round = null;
    this.state.fleets = {};
    this.state.arsenal = {};
    this.state.scores = {};
    this.state.usedQuestions = [];
    for (const team of this.state.teams) {
      team.missiles = 0;
      team.eliminated = false;
    }
    for (const player of this.state.players) {
      player.streak = 0;
      player.stats = emptyStats();
    }
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
      roundNumber: this.state.round?.number || null,
      roundPhase: this.state.round?.phase || null,
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
    schemaVersion: 2,
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
    round: null,
    fleets: {},
    arsenal: {},
    scores: {},
    usedQuestions: [],
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
