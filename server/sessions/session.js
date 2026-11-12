import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  DEFAULT_CONFIG,
  LIMITS,
  MODE_PRESETS,
  OPTIONS_PER_QUESTION,
  PHASES,
  ROLES,
  SCORING,
  TIMING,
} from '../../shared/constants.js';
import { cleanText, nameKey } from '../../shared/util.js';
import { GameError, assert } from '../errors.js';
import { hashToken, makePlayerToken, shortJoinUrlFor } from '../util/security.js';
import {
  CPU_ID,
  CPU_NAME,
  buildCombatants,
  buildTeams,
  cellKey,
  ensureScore,
  makeFleet,
  makeRound,
  shuffle,
} from './round.js';

const SCHEMA_VERSION = 3;

function emptyStats() {
  return { answered: 0, correct: 0, attacks: 0, hits: 0 };
}

export function createSessionState({
  id,
  joinCode,
  config,
  joinBaseUrl,
  displayBaseUrl,
  retentionHours = LIMITS.sessionRetentionHours,
  controlKeyHash = null,
}) {
  const now = new Date().toISOString();
  const merged = { ...DEFAULT_CONFIG, ...config };
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    joinCode,
    name: 'CYBER BATTLESHIPS',
    phase: PHASES.LOBBY,
    config: merged,
    teams: buildTeams(merged.mode, now),
    players: [],
    round: null,
    fleets: {},
    arsenal: {},
    scores: {},
    recentEvents: [],
    eventSeq: 0,
    version: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    endedAt: null,
    expiresAt: new Date(Date.now() + retentionHours * 3600_000).toISOString(),
    joinBaseUrl,
    displayBaseUrl,
    controlKeyHash,
  };
}

export class GameSession extends EventEmitter {
  constructor({ state, repository, logger, questions }) {
    super();
    this.state = state;
    this.repository = repository;
    this.logger = logger;
    this.questions = questions;
    this.closed = false;
    this.ticking = false;
    this.savePending = false;
    this.saveQueue = Promise.resolve();
    this.lastSaveError = null;
    this.ensureShape();

    for (const player of this.state.players) {
      player.connected = false;
      player.lastSeenAt = player.lastSeenAt || null;
    }
  }

  ensureShape() {
    const state = this.state;
    state.teams = Array.isArray(state.teams) ? state.teams : [];
    state.players = Array.isArray(state.players) ? state.players : [];
    state.recentEvents = Array.isArray(state.recentEvents) ? state.recentEvents : [];
    state.version = Number(state.version) || 0;
    state.eventSeq = Number(state.eventSeq) || 0;
    state.schemaVersion = SCHEMA_VERSION;
    state.round = state.round || null;
    state.fleets = state.fleets && typeof state.fleets === 'object' ? state.fleets : {};
    state.arsenal = state.arsenal && typeof state.arsenal === 'object' ? state.arsenal : {};
    state.scores = state.scores && typeof state.scores === 'object' ? state.scores : {};
    state.expiresAt =
      state.expiresAt || new Date(Date.now() + LIMITS.sessionRetentionHours * 3600_000).toISOString();
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

  get preset() {
    return MODE_PRESETS[this.state.config.mode] || MODE_PRESETS.squad;
  }

  playerById(playerId) {
    return this.state.players.find((player) => player.id === playerId) || null;
  }

  teamById(teamId) {
    return this.state.teams.find((team) => team.id === teamId) || null;
  }

  playersOnTeam(teamId) {
    return this.state.players.filter((player) => player.teamId === teamId);
  }

  teamOccupancy(teamId) {
    return this.playersOnTeam(teamId).length;
  }

  capacity() {
    return this.state.teams.reduce((total, team) => total + team.maxPlayers, 0);
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
    if (this.state.recentEvents.length > 40) {
      this.state.recentEvents.splice(0, this.state.recentEvents.length - 40);
    }
    this.repository.appendEvent(this.state.id, event.seq, type, payload);
    this.emit('event', event);
    return event;
  }

  bump() {
    this.state.version += 1;
    this.state.updatedAt = new Date().toISOString();
  }

  /**
   * Broadcast immediately and persist in a serialized queue. Saves coalesce:
   * if one is already waiting it will pick up the latest state when it runs.
   */
  commit() {
    this.emit('change');
    if (!this.savePending) {
      this.savePending = true;
      this.saveQueue = this.saveQueue
        .catch(() => {})
        .then(async () => {
          this.savePending = false;
          await this.repository.save(this.state);
        })
        .catch((error) => {
          this.lastSaveError = error;
          this.logger?.error({ err: error, sessionId: this.state.id }, 'Failed to persist session');
          throw new GameError('PERSISTENCE_ERROR', 'The game could not be saved. Please try again.');
        });
    }
    return this.saveQueue;
  }

  async flush() {
    await this.saveQueue.catch(() => {});
  }

  destroy() {
    this.closed = true;
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------- lobby

  join({ name, teamId = null }) {
    assert(this.state.phase === PHASES.LOBBY, 'JOIN_CLOSED', 'This game has already started.');
    const clean = cleanText(name, LIMITS.maxNameLength);
    assert(clean.length >= LIMITS.minNameLength, 'INVALID_NAME', 'That name is too short.');
    const key = nameKey(clean);
    assert(
      !this.state.players.some((player) => player.nameKey === key),
      'NAME_TAKEN',
      'That name is already taken.',
    );

    let team = null;
    if (teamId) {
      team = this.teamById(teamId);
      assert(team, 'INVALID_TEAM', 'That side no longer exists.');
      assert(this.teamOccupancy(team.id) < team.maxPlayers, 'TEAM_FULL', `${team.name} is full.`);
    } else {
      team =
        [...this.state.teams]
          .filter((entry) => this.teamOccupancy(entry.id) < entry.maxPlayers)
          .sort(
            (a, b) =>
              this.teamOccupancy(a.id) - this.teamOccupancy(b.id) || a.sortOrder - b.sortOrder,
          )[0] || null;
    }
    assert(team, 'GAME_FULL', 'This game is full.');
    return this.createPlayer({ name: clean, teamId: team.id });
  }

  createPlayer({ name, teamId }) {
    const token = makePlayerToken();
    const now = new Date().toISOString();
    const player = {
      id: `p_${crypto.randomUUID()}`,
      displayName: name,
      nameKey: nameKey(name),
      teamId: teamId || null,
      role: ROLES.PLAYER,
      tokenHash: hashToken(token),
      connected: true,
      joinedAt: now,
      lastSeenAt: now,
      cooldownUntil: null,
      streak: 0,
      stats: emptyStats(),
    };
    this.state.players.push(player);
    const team = this.teamById(teamId);
    this.recordEvent('player_joined', {
      playerId: player.id,
      name: player.displayName,
      teamId: player.teamId,
      teamName: team?.name || null,
    });
    this.bump();
    return { player, token };
  }

  resume(token) {
    const tokenHash = hashToken(token);
    return this.state.players.find((player) => player.tokenHash === tokenHash) || null;
  }

  async setConnected(playerId, connected) {
    const player = this.playerById(playerId);
    if (!player || player.connected === connected) return;
    player.connected = connected;
    player.lastSeenAt = new Date().toISOString();
    if (!connected && this.state.phase === PHASES.BATTLE) this.ensureCaptains();
    this.bump();
    await this.commit();
  }

  async chooseTeam(playerId, teamId) {
    assert(this.state.phase === PHASES.LOBBY, 'NOT_IN_LOBBY', 'Sides are locked.');
    assert(this.state.teams.length > 1, 'ONE_SIDE', 'There is only one side in this mode.');
    const player = this.playerById(playerId);
    assert(player, 'PLAYER_NOT_FOUND', 'Player not found.');
    const team = this.teamById(teamId);
    assert(team, 'INVALID_TEAM', 'That side no longer exists.');
    assert(player.teamId !== team.id, 'ALREADY_ON_TEAM', 'You are already on that side.');
    assert(this.teamOccupancy(team.id) < team.maxPlayers, 'TEAM_FULL', `${team.name} is full.`);
    const from = this.teamById(player.teamId);
    player.teamId = team.id;
    this.recordEvent('team_changed', {
      playerId: player.id,
      name: player.displayName,
      fromTeamName: from?.name || null,
      teamName: team.name,
    });
    this.bump();
    await this.commit();
  }

  async removePlayer(playerId) {
    const index = this.state.players.findIndex((player) => player.id === playerId);
    assert(index >= 0, 'PLAYER_NOT_FOUND', 'Player not found.');
    const [player] = this.state.players.splice(index, 1);
    if (this.state.round?.quiz) delete this.state.round.quiz[player.id];
    const team = this.teamById(player.teamId);
    this.recordEvent('player_removed', {
      playerId: player.id,
      name: player.displayName,
      teamName: team?.name || null,
    });
    this.bump();
    this.emit('playerRemoved', { playerId: player.id, name: player.displayName });
    await this.commit();
    return player;
  }

  async updateConfig(patch) {
    assert(this.state.phase === PHASES.LOBBY, 'NOT_IN_LOBBY', 'Settings are locked during a game.');
    if ('questionSet' in patch) {
      assert(this.questions.has(patch.questionSet), 'UNKNOWN_SET', 'That question set does not exist.');
    }
    if (patch.mode && patch.mode !== this.state.config.mode) this.changeMode(patch.mode);
    this.state.config = { ...this.state.config, ...patch };
    this.recordEvent('settings_changed', { keys: Object.keys(patch) });
    this.bump();
    await this.commit();
  }

  changeMode(mode) {
    const preset = MODE_PRESETS[mode];
    assert(preset, 'INVALID_MODE', 'Unknown game mode.');
    const capacity = preset.teams.length * preset.perTeam;
    const players = this.state.players;
    assert(
      players.length <= capacity,
      'TOO_MANY_PLAYERS',
      `${preset.label} holds ${capacity} player${capacity === 1 ? '' : 's'}. Remove players first.`,
    );

    const oldOrder = new Map(this.state.teams.map((team) => [team.id, team.sortOrder]));
    const teams = buildTeams(mode);
    const counts = new Map(teams.map((team) => [team.id, 0]));
    const pending = [];

    for (const player of players) {
      const team = teams[oldOrder.get(player.teamId)];
      if (team && counts.get(team.id) < team.maxPlayers) {
        player.teamId = team.id;
        counts.set(team.id, counts.get(team.id) + 1);
      } else {
        pending.push(player);
      }
    }
    for (const player of pending) {
      const team = teams
        .filter((entry) => counts.get(entry.id) < entry.maxPlayers)
        .sort((a, b) => counts.get(a.id) - counts.get(b.id))[0];
      player.teamId = team.id;
      counts.set(team.id, counts.get(team.id) + 1);
    }
    this.state.teams = teams;
  }

  // ---------------------------------------------------------------- arsenal

  arsenalFor(ownerId) {
    return Number(this.state.arsenal[ownerId]) || 0;
  }

  setArsenal(ownerId, value) {
    const next = Math.max(0, Number(value) || 0);
    this.state.arsenal[ownerId] = next;
    const team = this.teamById(ownerId);
    if (team) team.missiles = next;
    return next;
  }

  addArsenal(ownerId, amount) {
    return this.setArsenal(ownerId, this.arsenalFor(ownerId) + Number(amount || 0));
  }

  // ---------------------------------------------------------------- quiz

  /** Start a fresh game: new fleets, scores and ammunition, first question round. */
  beginRound() {
    const now = Date.now();
    const number = (this.state.round?.number || 0) + 1;
    const combatants = buildCombatants(this.state);

    this.state.scores = {};
    this.state.fleets = {};
    this.state.arsenal = {};
    for (const team of this.state.teams) {
      team.missiles = 0;
      team.captainPlayerId = null;
      team.captainHistory = [];
    }
    for (const combatant of combatants) {
      this.state.fleets[combatant.id] = makeFleet(this.config.gridSize);
      ensureScore(this.state, combatant.id);
      this.setArsenal(combatant.id, 0);
    }

    this.state.round = makeRound({
      number,
      now,
      quizEndsAt: now + this.config.quizMinutes * 60_000,
      combatants,
    });
    this.state.round.cycle = 0;
    this.state.round.battleEndReason = null;
    this.state.round.quizStartMissiles = {};

    for (const player of this.state.players) {
      player.stats = emptyStats();
      this.state.round.quiz[player.id] = { answered: 0, correct: 0, bonus: 0, seen: [], current: null };
    }

    this.startQuizCycle(now);
    this.state.startedAt = new Date(now).toISOString();
    this.state.endedAt = null;
    this.recordEvent('quiz_started', { round: number });
    this.bump();
  }

  /**
   * Begin a question round. The first one starts a game; later ones are started
   * when the sides run out of missiles. Fleets, shots, scores and any missiles
   * left over all carry on.
   */
  startQuizCycle(now = Date.now()) {
    const round = this.state.round;
    assert(round, 'NOT_IN_ROUND', 'No game is running.');
    round.cycle = (round.cycle || 0) + 1;
    round.quizStartedAt = new Date(now).toISOString();
    round.quizEndsAt = new Date(now + this.config.quizMinutes * 60_000).toISOString();
    round.battleStartedAt = null;
    round.battleEndsAt = null;
    round.battleEndReason = null;
    round.quizStartMissiles = {};
    for (const combatant of round.combatants) {
      if (combatant.kind === 'team') round.quizStartMissiles[combatant.id] = this.arsenalFor(combatant.id);
    }

    for (const player of this.state.players) {
      const entry = round.quiz[player.id] || { answered: 0, correct: 0, seen: [], current: null };
      round.quiz[player.id] = entry;
      entry.answered = 0;
      entry.correct = 0;
      entry.bonus = 0;
      player.streak = 0;
      this.issueQuestion(player.id, now);
    }

    this.assignCaptains();

    this.state.phase = PHASES.QUIZ;
    if (round.cycle > 1) {
      this.recordEvent('more_questions', { round: round.number, cycle: round.cycle });
    }
    this.bump();
  }

  // ---------------------------------------------------------------- captains

  /**
   * Each side has exactly one captain, who is the only player that fires its
   * missiles; everyone else watches. A new captain is chosen for every question
   * round, favouring players who have not had a turn yet and never repeating
   * the previous captain while the side has anyone else.
   */
  pickCaptain(team) {
    const players = this.playersOnTeam(team.id);
    if (players.length === 0) return null;
    team.captainHistory = Array.isArray(team.captainHistory) ? team.captainHistory : [];
    const online = players.filter((player) => player.connected);
    let pool = online.length > 0 ? online : players;
    if (pool.length > 1) pool = pool.filter((player) => player.id !== team.captainPlayerId);
    let fresh = pool.filter((player) => !team.captainHistory.includes(player.id));
    if (fresh.length === 0) {
      team.captainHistory = [];
      fresh = pool;
    }
    const chosen = fresh[crypto.randomInt(0, fresh.length)];
    team.captainHistory.push(chosen.id);
    return chosen;
  }

  assignCaptain(team) {
    const chosen = this.pickCaptain(team);
    team.captainPlayerId = chosen?.id || null;
    if (chosen) {
      this.recordEvent('captain_chosen', {
        playerId: chosen.id,
        name: chosen.displayName,
        teamId: team.id,
        teamName: team.name,
      });
    }
    return chosen;
  }

  assignCaptains() {
    for (const team of this.state.teams) this.assignCaptain(team);
  }

  /** The captain hands the attack controls to another connected member of their side. */
  async passCaptain(fromId, toId) {
    const phase = this.state.phase;
    assert(
      phase === PHASES.BATTLE || phase === PHASES.RESUPPLY || phase === PHASES.REVIEW,
      'NOT_BATTLE',
      'Controls can be passed once the battle is near.',
    );
    const from = this.playerById(fromId);
    assert(from, 'PLAYER_NOT_FOUND', 'Player not found.');
    const team = this.teamById(from.teamId);
    assert(team && team.captainPlayerId === from.id, 'NOT_CAPTAIN', 'Only the captain can pass the controls.');
    const to = this.playerById(toId);
    assert(
      to && to.id !== from.id && to.teamId === team.id,
      'INVALID_PLAYER',
      'Choose another member of your side.',
    );
    assert(to.connected, 'PLAYER_OFFLINE', `${to.displayName} is offline.`);
    team.captainPlayerId = to.id;
    team.captainHistory = Array.isArray(team.captainHistory) ? team.captainHistory : [];
    if (!team.captainHistory.includes(to.id)) team.captainHistory.push(to.id);
    this.recordEvent('captain_passed', {
      fromId: from.id,
      playerId: to.id,
      name: to.displayName,
      teamId: team.id,
      teamName: team.name,
    });
    this.bump();
    await this.commit();
    return { captainName: to.displayName };
  }

  /** Keep a firing captain in place: replace one who has left the game or gone offline. */
  ensureCaptains() {
    for (const team of this.state.teams) {
      const captain = this.playerById(team.captainPlayerId);
      const usable = captain && captain.teamId === team.id && captain.connected;
      if (usable) continue;
      const others = this.playersOnTeam(team.id).filter((player) => player.connected);
      if (!captain || captain.teamId !== team.id || others.length > 0) this.assignCaptain(team);
    }
  }

  issueQuestion(playerId, now = Date.now()) {
    const entry = this.state.round?.quiz?.[playerId];
    if (!entry) return null;
    const pool = this.questions.questionsFor(this.config.questionSet);
    if (!pool.length) {
      entry.current = null;
      return null;
    }

    let candidates = pool.filter((question) => !entry.seen.includes(question.id));
    if (candidates.length === 0) {
      entry.seen = [];
      candidates = pool;
    }
    const question = candidates[crypto.randomInt(0, candidates.length)];
    entry.seen.push(question.id);

    // Offer the right answer plus two wrong ones, in a random order so the
    // correct answer is not always in the same slot.
    const wrong = shuffle(question.options.map((_, index) => index).filter((index) => index !== question.answerIndex));
    const order = shuffle([question.answerIndex, ...wrong.slice(0, OPTIONS_PER_QUESTION - 1)]);
    entry.current = {
      number: entry.answered + 1,
      id: question.id,
      category: question.category,
      prompt: question.prompt,
      options: order.map((index) => question.options[index]),
      answerIndex: order.indexOf(question.answerIndex),
      explanation: question.explanation || '',
      issuedAt: new Date(now).toISOString(),
    };
    return entry.current;
  }

  async answer(playerId, questionNumber, optionIndex) {
    assert(this.state.phase === PHASES.QUIZ, 'NOT_QUIZ', 'The quiz is not running.');
    const round = this.state.round;
    const now = Date.now();
    assert(
      now <= Date.parse(round.quizEndsAt) + TIMING.answerGraceMs,
      'QUIZ_CLOSED',
      'Time is up.',
    );

    const player = this.playerById(playerId);
    assert(player, 'PLAYER_NOT_FOUND', 'Player not found.');
    const entry = round.quiz[player.id];
    assert(entry?.current, 'NO_QUESTION', 'No question is available.');
    const current = entry.current;
    assert(
      Number(questionNumber) === current.number,
      'QUESTION_CHANGED',
      'That question has already been answered.',
    );
    const index = Number(optionIndex);
    assert(
      Number.isInteger(index) && index >= 0 && index < current.options.length,
      'INVALID_ANSWER',
      'Choose one of the answers.',
    );

    const ownerId = player.teamId;
    assert(ownerId && this.teamById(ownerId), 'NO_TEAM', 'Join a side first.');

    const correct = index === current.answerIndex;
    player.streak = correct ? (Number(player.streak) || 0) + 1 : 0;
    const bonus =
      correct && player.streak >= SCORING.streakBonusFrom && player.streak <= SCORING.streakBonusThrough
        ? SCORING.streakBonusMissiles
        : 0;
    const reward = correct ? SCORING.missilesPerCorrect + bonus : 0;
    const score = ensureScore(this.state, ownerId);
    score.answered += 1;
    entry.answered += 1;
    player.stats.answered += 1;

    if (correct) {
      score.correct += 1;
      score.points += SCORING.correct;
      score.missilesEarned += reward;
      entry.correct += 1;
      entry.bonus = (entry.bonus || 0) + bonus;
      player.stats.correct += 1;
      this.addArsenal(ownerId, reward);
    }

    const result = {
      number: current.number,
      correct,
      correctIndex: current.answerIndex,
      chosenIndex: index,
      explanation: current.explanation,
      reward,
      bonus,
      streak: player.streak,
      missiles: this.arsenalFor(ownerId),
    };

    this.issueQuestion(player.id, now);
    this.bump();
    await this.commit();
    return result;
  }

  // ---------------------------------------------------------------- briefing

  enterReview() {
    assert(this.state.round, 'NOT_IN_ROUND', 'No game is running.');
    this.state.phase = PHASES.REVIEW;
    for (const entry of Object.values(this.state.round.quiz)) entry.current = null;
    this.recordEvent('briefing_started', { round: this.state.round.number });
    this.bump();
  }

  // ---------------------------------------------------------------- battle

  enterBattle(now = Date.now()) {
    const round = this.state.round;
    assert(round, 'NOT_IN_ROUND', 'No game is running.');
    round.battleStartedAt = new Date(now).toISOString();
    round.battleEndsAt = new Date(now + this.config.battleSeconds * 1000).toISOString();
    round.battleEndReason = null;
    this.ensureCaptains();
    this.state.phase = PHASES.BATTLE;
    this.recordEvent('battle_started', { round: round.number });
    this.bump();
  }

  /**
   * The battle stops without a winner: the timer ended, the sides ran out of
   * missiles, or the facilitator ended the round. The facilitator can then start
   * another question round to earn more missiles.
   */
  pauseBattle(reason = 'time') {
    const round = this.state.round;
    assert(round, 'NOT_IN_ROUND', 'No game is running.');
    round.battleEndReason = reason;
    this.state.phase = PHASES.RESUPPLY;
    this.recordEvent('battle_paused', { round: round.number, reason });
    this.bump();
  }

  /** Go back to firing with the missiles that are left. */
  resumeBattle(now = Date.now()) {
    assert(this.state.phase === PHASES.RESUPPLY, 'NOT_RESUPPLY', 'The battle is not paused.');
    assert(!this.noMissilesLeft(), 'NO_MISSILES', 'Nobody has missiles left. Start more questions first.');
    this.enterBattle(now);
  }

  async attack(playerId, x, y) {
    assert(this.state.phase === PHASES.BATTLE, 'NOT_BATTLE', 'The battle is not running.');
    const round = this.state.round;
    const player = this.playerById(playerId);
    assert(player, 'PLAYER_NOT_FOUND', 'Player not found.');
    const ownerId = player.teamId;
    const combatant = round.combatants.find((entry) => entry.id === ownerId);
    assert(combatant?.targetId, 'NO_TARGET', 'No target is assigned.');
    const side = this.teamById(ownerId);
    if (side && !this.playerById(side.captainPlayerId)) this.assignCaptain(side);
    assert(
      side?.captainPlayerId === player.id,
      'NOT_CAPTAIN',
      'Only your captain can fire missiles this round.',
    );

    const targetFleet = this.state.fleets[combatant.targetId];
    assert(targetFleet, 'NO_TARGET', 'That target is unavailable.');
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
      'Choose a cell inside the grid.',
    );
    assert(this.arsenalFor(ownerId) > 0, 'NO_MISSILES', 'No missiles left.');
    assert(
      !targetFleet.shots.some((shot) => shot.x === cx && shot.y === cy),
      'CELL_ALREADY_TARGETED',
      'That cell was already hit.',
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

    targetFleet.shots.push({ x: cx, y: cy, by: ownerId, hit, at: new Date(now).toISOString() });
    round.attacks.push({ ownerId, targetId: combatant.targetId, x: cx, y: cy, hit, sunkShip });

    const score = ensureScore(this.state, ownerId);
    player.stats.attacks += 1;
    if (hit) {
      score.hits += 1;
      score.points += SCORING.hit;
      player.stats.hits += 1;
      if (sunkShip) {
        score.sunk += 1;
        score.points += SCORING.sunk;
        this.recordEvent('ship_sunk', {
          teamName: combatant.name,
          targetName: round.combatants.find((entry) => entry.id === combatant.targetId)?.name,
          shipName: sunkShip,
        });
      }
    } else {
      score.misses += 1;
    }

    const eliminated = targetFleet.ships.every((entry) => entry.sunk);
    if (eliminated) this.finishBattle(now, { reason: 'Fleet destroyed', winnerId: ownerId });

    this.bump();
    await this.commit();

    return {
      hit,
      sunk: Boolean(sunkShip),
      shipName: sunkShip,
      eliminated,
      x: cx,
      y: cy,
      missiles: this.arsenalFor(ownerId),
    };
  }

  noMissilesLeft() {
    const sides = this.state.round?.combatants.filter((entry) => entry.kind === 'team') || [];
    return sides.length > 0 && sides.every((entry) => this.arsenalFor(entry.id) === 0);
  }

  finishBattle(now = Date.now(), { reason = 'Time expired', winnerId = null } = {}) {
    const round = this.state.round;
    assert(round, 'NOT_IN_ROUND', 'No game is running.');
    round.endedAt = new Date(now).toISOString();
    this.state.phase = PHASES.RESULT;
    this.state.endedAt = round.endedAt;

    const results = round.combatants.map((combatant) => {
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
        eliminated: shipsTotal > 0 && shipsSunk >= shipsTotal,
      };
    });
    round.results = results.sort((a, b) => b.points - a.points || b.hits - a.hits);

    const humans = results.filter((entry) => entry.kind === 'team');
    let outcome;

    if (this.preset.versusCpu) {
      const cpu = results.find((entry) => entry.kind === 'cpu');
      const crew = humans[0];
      const breached = Boolean(cpu?.eliminated);
      outcome = breached
        ? { winnerId: crew?.id || null, winnerName: crew?.name || 'CREW', winnerColor: crew?.color, reason: 'Firewall breached', humanWin: true, draw: false }
        : { winnerId: CPU_ID, winnerName: CPU_NAME, winnerColor: cpu?.color, reason: 'Firewall held', humanWin: false, draw: false };
    } else {
      let winner = winnerId ? humans.find((entry) => entry.id === winnerId) : null;
      let finalReason = reason;
      if (!winner) {
        const ranked = [...humans].sort((a, b) => b.points - a.points || b.hits - a.hits);
        const [first, second] = ranked;
        if (first && second && first.points === second.points && first.hits === second.hits) {
          outcome = { winnerId: null, winnerName: 'DRAW', winnerColor: '#d9f4ff', reason: 'Scores level', humanWin: false, draw: true };
        } else {
          winner = first || null;
          finalReason = 'Highest score';
        }
      }
      if (!outcome) {
        outcome = {
          winnerId: winner?.id || null,
          winnerName: winner?.name || 'NO WINNER',
          winnerColor: winner?.color || '#d9f4ff',
          reason: finalReason,
          humanWin: Boolean(winner),
          draw: false,
        };
      }
    }

    round.outcome = outcome;
    this.recordEvent('round_over', { round: round.number, winnerName: outcome.winnerName });
    this.bump();
  }

  // ---------------------------------------------------------------- timers

  async tick(now = Date.now()) {
    if (this.closed) return false;
    if (this.state.phase !== PHASES.QUIZ && this.state.phase !== PHASES.BATTLE) return false;
    if (this.ticking) return false;
    this.ticking = true;
    try {
      const round = this.state.round;
      if (!round) return false;
      let changed = false;

      if (this.state.phase === PHASES.QUIZ) {
        if (now >= Date.parse(round.quizEndsAt)) {
          this.enterReview();
          changed = true;
        }
      } else if (now >= Date.parse(round.battleEndsAt)) {
        this.pauseBattle('time');
        changed = true;
      } else if (
        now - Date.parse(round.battleStartedAt) >= TIMING.minBattleMs &&
        this.noMissilesLeft()
      ) {
        this.pauseBattle('ammo');
        changed = true;
      }

      if (changed) await this.commit();
      return changed;
    } catch (error) {
      this.logger?.error({ err: error, sessionId: this.state.id }, 'Game tick failed');
      return false;
    } finally {
      this.ticking = false;
    }
  }

  // ---------------------------------------------------------------- controls

  /** The single facilitator control: move to whatever comes next. */
  async advance() {
    const now = Date.now();
    switch (this.state.phase) {
      case PHASES.LOBBY:
      case PHASES.RESULT:
        this.beginRound();
        break;
      case PHASES.QUIZ:
        this.enterReview();
        break;
      case PHASES.REVIEW:
        this.enterBattle(now);
        break;
      case PHASES.BATTLE:
        this.pauseBattle('ended');
        break;
      case PHASES.RESUPPLY:
        this.startQuizCycle(now);
        break;
      default:
        throw new GameError('INVALID_PHASE', 'Nothing to advance.');
    }
    await this.commit();
  }

  /** Facilitator: pick up the missiles that are left and keep fighting. */
  async resumeFight() {
    this.resumeBattle(Date.now());
    await this.commit();
  }

  /** Facilitator: stop here and decide the winner on score. */
  async finish() {
    assert(
      [PHASES.REVIEW, PHASES.BATTLE, PHASES.RESUPPLY].includes(this.state.phase),
      'INVALID_PHASE',
      'The game can only be ended after the quiz.',
    );
    this.finishBattle(Date.now(), { reason: 'Ended by facilitator' });
    await this.commit();
  }

  async returnToLobby() {
    this.state.phase = PHASES.LOBBY;
    this.state.startedAt = null;
    this.state.endedAt = null;
    this.state.round = null;
    this.state.fleets = {};
    this.state.arsenal = {};
    this.state.scores = {};
    for (const team of this.state.teams) {
      team.missiles = 0;
      team.eliminated = false;
      team.captainPlayerId = null;
      team.captainHistory = [];
    }
    for (const player of this.state.players) {
      player.streak = 0;
      player.stats = emptyStats();
    }
    this.recordEvent('returned_to_lobby', {});
    this.bump();
    await this.commit();
  }

  // ---------------------------------------------------------------- views

  /** Progress per side, shared by the quiz, briefing and result screens. */
  teamProgress() {
    const round = this.state.round;
    if (!round) return [];
    return [...this.state.teams]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((team) => {
        const players = this.playersOnTeam(team.id)
          .map((player) => {
            const entry = round.quiz?.[player.id] || {};
            return {
              id: player.id,
              name: player.displayName,
              answered: entry.answered || 0,
              correct: entry.correct || 0,
              bonus: entry.bonus || 0,
              shots: Number(player.stats?.attacks) || 0,
              hits: Number(player.stats?.hits) || 0,
              connected: Boolean(player.connected),
            };
          })
          .sort((a, b) => b.correct - a.correct || a.name.localeCompare(b.name));
        const answered = players.reduce((total, player) => total + player.answered, 0);
        const correct = players.reduce((total, player) => total + player.correct, 0);
        const bonus = players.reduce((total, player) => total + player.bonus, 0);
        return {
          id: team.id,
          name: team.name,
          color: team.color,
          answered,
          correct,
          accuracy: answered > 0 ? Math.round((correct / answered) * 100) : 0,
          won: correct * SCORING.missilesPerCorrect + bonus,
          missiles: this.arsenalFor(team.id),
          points: Number(this.state.scores[team.id]?.points) || 0,
          players,
        };
      });
  }

  summary() {
    return {
      id: this.state.id,
      joinCode: this.state.joinCode,
      phase: this.state.phase,
      mode: this.config.mode,
      playerCount: this.state.players.length,
      connectedCount: this.state.players.filter((player) => player.connected).length,
      roundNumber: this.state.round?.number || null,
      createdAt: this.state.createdAt,
      expiresAt: this.state.expiresAt,
      joinUrl: shortJoinUrlFor(this.state.joinBaseUrl, this.state.joinCode),
    };
  }
}

export { CPU_ID, CPU_NAME };
