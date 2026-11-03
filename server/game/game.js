/**
 * Authoritative game state machine.
 *
 * Owns teams, players, grids, questions, scoring and phase timers. All
 * mutations are validated here, which lets the socket layer stay thin and
 * keeps every connected screen consistent.
 *
 * Events:
 *   change  - state changed, broadcast a new projection
 *   fx      - discrete animation/sound cue for clients
 *   toast   - short human-readable message
 *   kick    - a player was removed and should be disconnected
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { Grid } from './grid.js';
import {
  AWARD_MODES,
  DEFAULT_SETTINGS,
  FLEET_TOTAL_CELLS,
  GameError,
  LIMITS,
  MODES,
  PHASES,
  POINTS,
  QUESTION_MODES,
  TEAM_COLORS,
  assert,
  clamp,
  coordName,
  toInt,
} from './constants.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SNAPSHOT_VERSION = 1;

export function makeCode(length = 5) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

export function cleanName(input, maxLength = LIMITS.maxNameLength) {
  return String(input ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function shuffle(list, rng = Math.random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export class Game extends EventEmitter {
  constructor({ store, code, settings = {}, rng = Math.random, snapshot = null }) {
    super();
    this.store = store;
    this.rng = rng;
    this.code = code || makeCode();
    this.settings = { ...DEFAULT_SETTINGS, ...settings, teamNames: [...(settings.teamNames || DEFAULT_SETTINGS.teamNames)] };

    this.phase = PHASES.LOBBY;
    this.paused = false;
    this.ending = false;
    this.phaseEndsAt = null;
    this.pauseRemainingMs = null;

    this.teams = [];
    this.players = new Map();
    this.grids = new Map();
    this.round = null;
    this.shots = [];
    this.deck = [];
    this.askedCount = 0;
    this.winnerTeamId = null;
    this.final = null;
    this.hostTokens = new Set();
    this.teamSeq = 0;
    this.seq = 0;
    this.revision = 0;

    this._timer = null;

    if (snapshot) this.restore(snapshot);
    else this.rebuild();
  }

  // ---------------------------------------------------------------- settings

  updateSettings(patch = {}) {
    assert(patch && typeof patch === 'object', 'INVALID_SETTINGS', 'Invalid settings payload.');

    const structuralKeys = ['gridCount', 'mode', 'maxPerTeam', 'maxPlayers', 'teamNames'];
    const isStructural = structuralKeys.some((key) => key in patch);
    if (isStructural) {
      assert(this.phase === PHASES.LOBBY, 'NOT_IN_LOBBY', 'Game structure can only be changed in the lobby.');
      assert(this.players.size === 0, 'PLAYERS_PRESENT', 'Remove players before changing the game structure.');
    }

    const next = { ...this.settings };

    if ('gridCount' in patch) {
      next.gridCount = clamp(toInt(patch.gridCount, 2), 1, LIMITS.maxGridCount);
    }
    if ('mode' in patch) {
      assert(Object.values(MODES).includes(patch.mode), 'INVALID_SETTINGS', 'Unknown game mode.');
      next.mode = patch.mode;
    }
    if ('maxPerTeam' in patch) {
      next.maxPerTeam = clamp(toInt(patch.maxPerTeam, 6), 0, 20);
    }
    if ('maxPlayers' in patch) {
      next.maxPlayers = clamp(toInt(patch.maxPlayers, 24), 1, 60);
    }
    if ('awardMode' in patch) {
      assert(Object.values(AWARD_MODES).includes(patch.awardMode), 'INVALID_SETTINGS', 'Unknown award mode.');
      next.awardMode = patch.awardMode;
    }
    if ('questionMode' in patch) {
      assert(Object.values(QUESTION_MODES).includes(patch.questionMode), 'INVALID_SETTINGS', 'Unknown question mode.');
      next.questionMode = patch.questionMode;
    }
    if ('maxAttempts' in patch) {
      next.maxAttempts = clamp(toInt(patch.maxAttempts, 1), 1, LIMITS.maxAttempts);
    }
    if ('missileCap' in patch) {
      next.missileCap = clamp(toInt(patch.missileCap, 0), 0, 20);
    }
    if ('questionSeconds' in patch) {
      next.questionSeconds = clamp(toInt(patch.questionSeconds, 30), 0, LIMITS.maxQuestionSeconds);
    }
    if ('revealSeconds' in patch) {
      next.revealSeconds = clamp(toInt(patch.revealSeconds, 10), 0, 120);
    }
    if ('autoIntervalSeconds' in patch) {
      next.autoIntervalSeconds = clamp(toInt(patch.autoIntervalSeconds, 30), 5, 600);
    }
    for (const key of ['missilesRetained', 'allowLateJoin', 'soundOn', 'revealShips']) {
      if (key in patch) next[key] = Boolean(patch[key]);
    }

    if ('teamNames' in patch) {
      const names = (Array.isArray(patch.teamNames) ? patch.teamNames : [])
        .map((name) => cleanName(name, LIMITS.maxTeamNameLength))
        .filter(Boolean);
      assert(names.length >= 1, 'INVALID_SETTINGS', 'At least one team name is required.');
      assert(names.length <= LIMITS.maxTeams, 'INVALID_SETTINGS', `A maximum of ${LIMITS.maxTeams} teams is supported.`);
      next.teamNames = names;
    }

    // Keep the team list coherent with the grid count.
    if (next.gridCount > 1) {
      next.teamNames = next.teamNames.slice(0, next.gridCount);
      while (next.teamNames.length < next.gridCount) {
        next.teamNames.push(DEFAULT_SETTINGS.teamNames[next.teamNames.length] || `TEAM ${next.teamNames.length + 1}`);
      }
    } else if (next.mode === MODES.TEAMS) {
      if (next.teamNames.length < 2) next.teamNames.push(DEFAULT_SETTINGS.teamNames[next.teamNames.length] || 'BRAVO');
    }

    this.settings = next;
    if (isStructural) this.rebuild();
    this.touch();
  }

  /** Rebuild teams/grids from settings. Only safe in the lobby with no players. */
  rebuild() {
    this.teams = [];
    this.players = new Map();
    this.grids = new Map();
    this.shots = [];
    this.teamSeq = 0;

    const count = this.settings.gridCount;
    if (count > 1) {
      for (let i = 0; i < count; i += 1) {
        const id = `g${i + 1}`;
        const team = this._createTeam(this.settings.teamNames[i] || `TEAM ${i + 1}`, id);
        this.grids.set(id, new Grid({ id, ownerTeamId: team.id, label: team.name }));
      }
    } else {
      this.grids.set('target', new Grid({ id: 'target', label: 'TARGET FLEET' }));
      if (this.settings.mode === MODES.TEAMS) {
        const names = this.settings.teamNames.length ? this.settings.teamNames : ['ALPHA', 'BRAVO'];
        names.forEach((name) => this._createTeam(name, null));
      }
    }
  }

  _createTeam(name, gridId = null) {
    this.teamSeq += 1;
    const index = this.teams.length;
    const team = {
      id: `t${this.teamSeq}`,
      name: cleanName(name, LIMITS.maxTeamNameLength) || `TEAM ${index + 1}`,
      baseName: cleanName(name, LIMITS.maxTeamNameLength) || `TEAM ${index + 1}`,
      color: TEAM_COLORS[index % TEAM_COLORS.length],
      gridId,
      players: [],
      missiles: 0,
      score: 0,
      eliminated: false,
      stats: {
        correctAnswers: 0,
        missilesEarned: 0,
        missilesFired: 0,
        hits: 0,
        misses: 0,
        shipsSunk: 0,
        shipsLost: 0,
      },
    };
    this.teams.push(team);
    return team;
  }

  getTeam(teamId) {
    return this.teams.find((team) => team.id === teamId) || null;
  }

  getPlayer(playerId) {
    return this.players.get(playerId) || null;
  }

  get isOneGrid() {
    return this.settings.gridCount === 1;
  }

  get capacity() {
    return this.settings.mode === MODES.INDIVIDUAL ? 1 : this.settings.maxPerTeam || Infinity;
  }

  // ----------------------------------------------------------------- players

  join({ code, name, teamId = null }) {
    assert(this.phase !== PHASES.ENDED, 'GAME_OVER', 'This game has finished. Ask the host for a new session.');
    assert(
      this.phase === PHASES.LOBBY || this.settings.allowLateJoin,
      'JOIN_CLOSED',
      'Joining is closed - the game is already running.',
    );
    const clean = cleanName(name);
    assert(clean.length >= LIMITS.minNameLength, 'INVALID_NAME', `Use at least ${LIMITS.minNameLength} characters for your name.`);
    assert(this.players.size < this.settings.maxPlayers, 'GAME_FULL', 'This game is full.');

    const normalisedCode = String(code ?? '').trim().toUpperCase();
    assert(normalisedCode === this.code, 'INVALID_CODE', 'That game code is not valid.');

    const duplicate = [...this.players.values()].find(
      (player) => player.name.toLowerCase() === clean.toLowerCase(),
    );
    assert(!duplicate, 'NAME_TAKEN', 'That name is already in use in this game.');

    let team = null;

    if (this.isOneGrid && this.settings.mode === MODES.INDIVIDUAL) {
      team = this._createTeam(clean, null);
      team.baseName = clean;
    } else {
      if (teamId) {
        team = this.getTeam(teamId);
        assert(team, 'INVALID_TEAM', 'That team no longer exists.');
      } else {
        const candidates = this.teams.filter((entry) => entry.players.length < this.capacity);
        candidates.sort((a, b) => a.players.length - b.players.length);
        team = candidates[0] || null;
      }
      assert(team, 'TEAM_FULL', 'There is no space left on a team.');
      assert(team.players.length < this.capacity, 'TEAM_FULL', 'That team is already full.');
    }

    const player = {
      id: `p_${crypto.randomUUID()}`,
      token: crypto.randomBytes(24).toString('hex'),
      name: clean,
      teamId: team.id,
      connected: true,
      joinedAt: Date.now(),
      round: null,
      totals: { answers: 0, correct: 0 },
      nonces: [],
    };

    this.players.set(player.id, player);
    team.players.push(player.id);

    if (this.settings.mode === MODES.INDIVIDUAL) {
      team.name = clean;
      team.baseName = clean;
    }
    if (team.gridId) {
      const grid = this.grids.get(team.gridId);
      if (grid) grid.label = team.name;
    }

    this.emit('toast', { level: 'join', message: `${clean} joined ${team.name}` });
    this.touch();
    return player;
  }

  resumeByToken(token) {
    const player = [...this.players.values()].find((entry) => entry.token === token);
    if (!player) return null;
    player.connected = true;
    this.touch();
    return player;
  }

  setConnected(playerId, connected) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.connected === connected) return;
    player.connected = connected;
    this.touch();
  }

  removePlayer(playerId, reason = 'removed') {
    const player = this.players.get(playerId);
    if (!player) return;
    const team = this.getTeam(player.teamId);

    this.players.delete(playerId);
    if (team) {
      team.players = team.players.filter((id) => id !== playerId);

      if (this.settings.mode === MODES.INDIVIDUAL) {
        if (this.isOneGrid) {
          this.teams = this.teams.filter((entry) => entry.id !== team.id);
        } else if (team.players.length === 0) {
          team.name = team.baseName;
          team.score = 0;
          team.missiles = 0;
          team.eliminated = false;
          team.stats = {
            correctAnswers: 0,
            missilesEarned: 0,
            missilesFired: 0,
            hits: 0,
            misses: 0,
            shipsSunk: 0,
            shipsLost: 0,
          };
          const grid = this.grids.get(team.gridId);
          if (grid) {
            grid.label = `SLOT ${this.teams.findIndex((entry) => entry.id === team.id) + 1}`;
            grid.placeRandom(this.rng);
          }
        }
      }

      if (team.players.length === 0 && this.phase !== PHASES.LOBBY && !this.isOneGrid) {
        const grid = this.grids.get(team.gridId);
        if (grid && !team.eliminated) {
          team.eliminated = true;
          this.emit('fx', { type: 'eliminate', teamId: team.id, teamName: team.name, reason: 'abandoned' });
          this._checkGameOver();
        }
      }
    }

    this.emit('kick', { playerId, reason });
    this.emit('toast', { level: 'leave', message: `${player.name} removed` });
    this.touch();
  }

  movePlayer(playerId, teamId) {
    assert(this.phase === PHASES.LOBBY, 'NOT_IN_LOBBY', 'Players can only be moved in the lobby.');
    const player = this.players.get(playerId);
    assert(player, 'PLAYER_NOT_FOUND', 'Player not found.');
    const from = this.getTeam(player.teamId);
    const to = this.getTeam(teamId);
    assert(to, 'INVALID_TEAM', 'That team does not exist.');
    assert(to.id !== player.teamId, 'INVALID_MOVE', 'The player is already on that team.');
    assert(to.players.length < this.capacity, 'TEAM_FULL', 'That team is already full.');

    if (from) {
      from.players = from.players.filter((id) => id !== playerId);
      if (this.settings.mode === MODES.INDIVIDUAL) from.name = from.baseName;
    }
    to.players.push(playerId);
    player.teamId = to.id;
    if (this.settings.mode === MODES.INDIVIDUAL) {
      to.name = player.name;
      to.baseName = player.name;
    }
    this.touch();
  }

  setTeamName(teamId, name) {
    const team = this.getTeam(teamId);
    assert(team, 'INVALID_TEAM', 'That team does not exist.');
    const clean = cleanName(name, LIMITS.maxTeamNameLength);
    assert(clean.length >= 2, 'INVALID_NAME', 'Team names need at least two characters.');
    team.name = clean;
    if (this.settings.mode === MODES.TEAMS) team.baseName = clean;
    const grid = team.gridId ? this.grids.get(team.gridId) : null;
    if (grid) grid.label = clean;
    this.settings.teamNames = this.teams
      .filter((entry) => entry.gridId || this.settings.mode === MODES.TEAMS)
      .map((entry) => entry.baseName);
    this.touch();
  }

  addTeam(name) {
    assert(this.phase === PHASES.LOBBY, 'NOT_IN_LOBBY', 'Teams can only be added in the lobby.');
    assert(this.isOneGrid && this.settings.mode === MODES.TEAMS, 'INVALID_MODE', 'Additional teams are only available in shared-target team mode.');
    assert(this.teams.length < LIMITS.maxTeams, 'TEAM_LIMIT', `A maximum of ${LIMITS.maxTeams} teams is supported.`);
    const team = this._createTeam(cleanName(name) || `TEAM ${this.teams.length + 1}`, null);
    this.settings.teamNames = this.teams.map((entry) => entry.baseName);
    this.touch();
    return team;
  }

  removeTeam(teamId) {
    assert(this.phase === PHASES.LOBBY, 'NOT_IN_LOBBY', 'Teams can only be removed in the lobby.');
    const team = this.getTeam(teamId);
    assert(team, 'INVALID_TEAM', 'That team does not exist.');
    assert(this.isOneGrid && this.settings.mode === MODES.TEAMS, 'INVALID_MODE', 'Teams cannot be removed in this mode.');
    assert(team.players.length === 0, 'TEAM_NOT_EMPTY', 'Remove the players first.');
    assert(this.teams.length > 1, 'TEAM_LIMIT', 'At least one team is required.');
    this.teams = this.teams.filter((entry) => entry.id !== teamId);
    this.settings.teamNames = this.teams.map((entry) => entry.baseName);
    this.touch();
  }

  // ------------------------------------------------------------------- ships

  randomiseShips(gridId = null) {
    assert(this.phase === PHASES.LOBBY || this.phase === PHASES.ENDED, 'SHIPS_LOCKED', 'Ships cannot be moved once the game is running.');
    const targets = gridId ? [this.grids.get(gridId)] : [...this.grids.values()];
    for (const grid of targets) {
      assert(grid, 'INVALID_GRID', 'Grid not found.');
      grid.placeRandom(this.rng);
      grid.locked = false;
    }
    this.touch();
  }

  setShips(gridId, ships) {
    assert(this.phase === PHASES.LOBBY || this.phase === PHASES.ENDED, 'SHIPS_LOCKED', 'Ships cannot be moved once the game is running.');
    const grid = this.grids.get(gridId);
    assert(grid, 'INVALID_GRID', 'Grid not found.');
    grid.setShips(ships);
    this.touch();
  }

  // ------------------------------------------------------------------- start

  start() {
    assert(this.phase === PHASES.LOBBY, 'NOT_IN_LOBBY', 'The game is already running.');
    assert(this.store.count > 0, 'NO_QUESTIONS', 'Add at least one question before starting.');

    if (this.settings.gridCount > 1) {
      assert(this.teams.length >= 2, 'NOT_ENOUGH_TEAMS', 'Two or more teams are required.');
      const empty = this.teams.filter((team) => team.players.length === 0);
      assert(empty.length === 0, 'TEAM_EMPTY', `Every team needs at least one player (${empty.map((t) => t.name).join(', ')}).`);
    } else {
      if (this.settings.mode === MODES.TEAMS) {
        this.teams = this.teams.filter((team) => team.players.length > 0);
        assert(this.teams.length >= 1, 'NO_PLAYERS', 'At least one player is required.');
        this.settings.teamNames = this.teams.map((team) => team.baseName);
      } else {
        assert(this.players.size >= 1, 'NO_PLAYERS', 'At least one player is required.');
      }
    }

    for (const grid of this.grids.values()) {
      if (!grid.ships.length) grid.placeRandom(this.rng);
    }

    this.teams.forEach((team) => {
      team.score = 0;
      team.missiles = 0;
      team.eliminated = false;
      team.stats = {
        correctAnswers: 0,
        missilesEarned: 0,
        missilesFired: 0,
        hits: 0,
        misses: 0,
        shipsSunk: 0,
        shipsLost: 0,
      };
    });
    for (const player of this.players.values()) {
      player.round = null;
      player.totals = { answers: 0, correct: 0 };
      player.nonces = [];
    }

    this.shots = [];
    this.askedCount = 0;
    this.deck = shuffle(this.store.ids());
    this.ending = false;
    this.winnerTeamId = null;
    this.final = null;
    this.phase = PHASES.BATTLE;
    this.phaseEndsAt = null;

    this.emit('fx', { type: 'start' });
    this.touch();
    this.askNextQuestion();
  }

  // --------------------------------------------------------------- questions

  askNextQuestion() {
    assert(this.phase !== PHASES.LOBBY, 'NOT_STARTED', 'Start the game first.');
    assert(this.phase !== PHASES.ENDED, 'GAME_OVER', 'The game has ended.');
    assert(this.store.count > 0, 'NO_QUESTIONS', 'There are no questions available.');
    if (!this.settings.missilesRetained) {
      this.teams.forEach((team) => {
        team.missiles = 0;
      });
    }

    if (!this.deck.length) this.deck = shuffle(this.store.ids(), this.rng);
    let question = null;
    while (this.deck.length) {
      const id = this.deck.pop();
      question = this.store.get(id);
      if (question) break;
    }
    if (!question) {
      this.deck = shuffle(this.store.ids(), this.rng);
      const id = this.deck.pop();
      question = id ? this.store.get(id) : null;
    }
    assert(question, 'NO_QUESTIONS', 'There are no questions available.');

    for (const player of this.players.values()) player.round = null;

    this.askedCount += 1;
    this.round = {
      questionId: question.id,
      question: { ...question, options: [...question.options] },
      number: this.askedCount,
      startedAt: Date.now(),
      endsAt: null,
      revealedAt: null,
      firstCorrectTeamId: null,
      awards: [],
    };

    this.phase = PHASES.QUESTION;
    this.paused = false;
    this.pauseRemainingMs = null;
    const seconds = this.settings.questionSeconds;
    this.phaseEndsAt = seconds > 0 ? Date.now() + seconds * 1000 : null;
    this.round.endsAt = this.phaseEndsAt;
    this._schedulePhase();
    this.touch();
  }

  submitAnswer(playerId, questionId, optionIndex) {
    assert(!this.paused, 'PAUSED', 'The game is paused.');
    assert(this.phase === PHASES.QUESTION, 'NOT_ACCEPTING_ANSWERS', 'Answers are closed.');
    assert(this.round && this.round.questionId === questionId, 'STALE_QUESTION', 'That question is no longer active.');

    const player = this.players.get(playerId);
    assert(player, 'PLAYER_NOT_FOUND', 'Player not found.');
    const team = this.getTeam(player.teamId);
    assert(team, 'INVALID_TEAM', 'Team not found.');
    assert(!team.eliminated, 'ELIMINATED', 'Your fleet has been destroyed - you are spectating.');

    const index = toInt(optionIndex, -1);
    const optionCount = this.round.question.options.length;
    assert(index >= 0 && index < optionCount, 'INVALID_ANSWER', 'Choose one of the available answers.');

    const existing = player.round;
    if (existing?.locked) throw new GameError('ANSWER_LOCKED', 'Your answer is already locked in.');

    const attempts = (existing?.attempts || 0) + 1;
    const correct = index === this.round.question.correctIndex;

    player.round = {
      questionId,
      attempts,
      answerIndex: index,
      correct,
      locked: correct || attempts >= this.settings.maxAttempts,
      at: Date.now(),
    };
    player.totals.answers += 1;

    if (correct) {
      player.totals.correct += 1;
      team.stats.correctAnswers += 1;
      team.score += POINTS.correct;

      const isFirst = this.round.firstCorrectTeamId === null;
      if (isFirst) {
        this.round.firstCorrectTeamId = team.id;
        team.score += POINTS.firstBonus;
      }

      const cap = this.settings.missileCap;
      const withinCap = cap === 0 || team.missiles < cap;
      const award = withinCap && (this.settings.awardMode === AWARD_MODES.ALL || isFirst);

      if (award) {
        team.missiles += 1;
        team.stats.missilesEarned += 1;
        player.round.awarded = true;
        this.round.awards.push({
          teamId: team.id,
          teamName: team.name,
          playerName: player.name,
          at: Date.now(),
        });
        this.emit('fx', {
          type: 'award',
          teamId: team.id,
          teamName: team.name,
          playerName: player.name,
          missiles: team.missiles,
        });
      }
    }

    this.touch();
    return player.round;
  }

  revealQuestion() {
    assert(this.phase === PHASES.QUESTION, 'INVALID_PHASE', 'There is no open question to reveal.');
    this._clearTimer();
    this.phase = PHASES.REVEAL;
    this.round.revealedAt = Date.now();
    this.paused = false;
    this.pauseRemainingMs = null;
    this.phaseEndsAt = this.settings.questionMode === QUESTION_MODES.AUTO && this.settings.revealSeconds > 0
      ? Date.now() + this.settings.revealSeconds * 1000
      : null;
    this._schedulePhase();
    this.touch();
  }

  enterBattle() {
    assert(
      this.phase === PHASES.REVEAL || this.phase === PHASES.QUESTION,
      'INVALID_PHASE',
      'Cannot open the battle phase right now.',
    );
    this._clearTimer();
    this.phase = PHASES.BATTLE;
    this.paused = false;
    this.pauseRemainingMs = null;
    this.phaseEndsAt = this.settings.questionMode === QUESTION_MODES.AUTO
      ? Date.now() + this.settings.autoIntervalSeconds * 1000
      : null;
    this._schedulePhase();
    this.touch();
  }

  nextQuestion() {
    assert(
      this.phase === PHASES.BATTLE || this.phase === PHASES.REVEAL,
      'INVALID_PHASE',
      'Reveal the current question before moving on.',
    );
    this.askNextQuestion();
  }

  setPaused(paused) {
    assert(
      [PHASES.QUESTION, PHASES.REVEAL, PHASES.BATTLE].includes(this.phase),
      'INVALID_PHASE',
      'There is nothing to pause.',
    );
    const next = Boolean(paused);
    if (next === this.paused) return;

    if (next) {
      this.pauseRemainingMs = this.phaseEndsAt ? Math.max(0, this.phaseEndsAt - Date.now()) : null;
      this._clearTimer();
      this.paused = true;
      this.phaseEndsAt = null;
    } else {
      this.paused = false;
      if (this.pauseRemainingMs !== null) {
        this.phaseEndsAt = Date.now() + this.pauseRemainingMs;
        this.pauseRemainingMs = null;
        this._schedulePhase();
      }
    }
    this.touch();
  }

  // -------------------------------------------------------------------- fire

  fire(playerId, targetGridId, col, row, nonce = null) {
    assert(!this.paused, 'PAUSED', 'The game is paused.');
    assert(!this.ending, 'GAME_ENDING', 'The game is finishing.');
    assert(
      this.phase === PHASES.BATTLE,
      'INVALID_PHASE',
      'Missiles can only be fired once the combat phase opens.',
    );
    const player = this.players.get(playerId);
    assert(player, 'PLAYER_NOT_FOUND', 'Player not found.');
    const team = this.getTeam(player.teamId);
    assert(team, 'INVALID_TEAM', 'Team not found.');
    assert(!team.eliminated, 'ELIMINATED', 'Your fleet has been destroyed - you cannot fire.');
    assert(team.missiles > 0, 'NO_MISSILES', 'You have no missiles. Answer a question correctly to earn one.');

    const grid = this.grids.get(targetGridId);
    assert(grid, 'INVALID_GRID', 'Target grid not found.');
    if (!this.isOneGrid) {
      assert(grid.ownerTeamId !== team.id, 'OWN_GRID', 'You cannot fire at your own fleet.');
    } else {
      assert(grid.id === 'target', 'INVALID_GRID', 'Invalid target.');
    }

    const c = toInt(col, -1);
    const r = toInt(row, -1);
    assert(grid.inBounds(c, r), 'INVALID_COORDINATE', 'That coordinate is outside the grid.');
    assert(!grid.hasShot(c, r), 'ALREADY_FIRED', 'That coordinate has already been targeted.');

    if (nonce) {
      assert(!player.nonces.includes(nonce), 'DUPLICATE_ACTION', 'That shot was already fired.');
      player.nonces = [nonce, ...player.nonces].slice(0, 20);
    }

    team.missiles -= 1;
    team.stats.missilesFired += 1;

    const result = grid.fire(c, r, team.id);
    if (result.hit) {
      team.stats.hits += 1;
      team.score += POINTS.hit;
    } else {
      team.stats.misses += 1;
    }

    let eliminatedTeam = null;
    if (result.sunk) {
      team.stats.shipsSunk += 1;
      team.score += POINTS.sunk;
      const owner = grid.ownerTeamId ? this.getTeam(grid.ownerTeamId) : null;
      if (owner) owner.stats.shipsLost = (owner.stats.shipsLost || 0) + 1;
    }

    const shot = {
      seq: ++this.seq,
      at: Date.now(),
      teamId: team.id,
      teamName: team.name,
      playerName: player.name,
      targetGridId: grid.id,
      targetName: grid.ownerTeamId ? this.getTeam(grid.ownerTeamId)?.name || grid.label : grid.label,
      col: c,
      row: r,
      coord: coordName(c, r),
      hit: result.hit,
      sunk: result.sunk,
      sunkShipName: result.sunkShipName,
      missilesLeft: team.missiles,
    };
    this.shots.unshift(shot);
    if (this.shots.length > 120) this.shots.length = 120;

    if (grid.ownerTeamId && grid.destroyed) {
      const owner = this.getTeam(grid.ownerTeamId);
      if (owner && !owner.eliminated) {
        owner.eliminated = true;
        owner.missiles = 0;
        eliminatedTeam = owner;
        this.emit('fx', {
          type: 'eliminate',
          teamId: owner.id,
          teamName: owner.name,
          reason: 'fleet-destroyed',
        });
      }
    }

    this.emit('fx', { type: 'fire', ...shot });
    this._checkGameOver(eliminatedTeam);
    this.touch();
    return shot;
  }

  // --------------------------------------------------------------- game over

  _checkGameOver(eliminatedTeam = null) {
    if (this.ending) return;

    if (this.isOneGrid) {
      const target = this.grids.get('target');
      if (target?.destroyed) this._finishSoon('target-destroyed');
      return;
    }

    if (eliminatedTeam) {
      const alive = this.teams.filter((team) => !team.eliminated);
      if (alive.length <= 1) this._finishSoon('last-fleet');
    }
  }

  _finishSoon(reason) {
    if (this.ending) return;
    this.ending = true;
    this._clearTimer();
    this.phaseEndsAt = null;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.endGame(reason);
    }, 2600);
    this.touch();
  }

  endGame(reason = 'host-ended') {
    if (this.phase === PHASES.ENDED) return;
    this._clearTimer();
    this.phase = PHASES.ENDED;
    this.phaseEndsAt = null;
    this.paused = false;
    this.ending = false;
    this.pauseRemainingMs = null;

    const ranking = [...this.teams]
      .map((team) => ({
        teamId: team.id,
        name: team.name,
        color: team.color,
        score: team.score,
        missiles: team.missiles,
        eliminated: team.eliminated,
        stats: { ...team.stats },
        accuracy: team.stats.missilesFired
          ? Math.round((team.stats.hits / team.stats.missilesFired) * 100)
          : 0,
      }))
      .sort((a, b) => (
        b.score - a.score
        || b.stats.hits - a.stats.hits
        || b.stats.correctAnswers - a.stats.correctAnswers
        || a.name.localeCompare(b.name)
      ));

    let winnerTeamId = ranking[0]?.teamId ?? null;
    if (!this.isOneGrid) {
      const alive = this.teams.filter((team) => !team.eliminated);
      if (alive.length === 1) winnerTeamId = alive[0].id;
    }

    const target = this.isOneGrid ? this.grids.get('target') : null;
    this.winnerTeamId = winnerTeamId;
    this.final = {
      reason,
      winnerTeamId,
      winnerName: this.getTeam(winnerTeamId)?.name ?? null,
      ranking,
      targetDestroyed: target ? target.destroyed : false,
      askedQuestions: this.askedCount,
      shotsFired: this.teams.reduce((sum, team) => sum + team.stats.missilesFired, 0),
      endedAt: Date.now(),
    };

    this.emit('fx', { type: 'gameover', winnerTeamId, winnerName: this.final.winnerName, reason });
    this.touch();
  }

  restart() {
    assert(this.phase !== PHASES.LOBBY, 'NOT_STARTED', 'Start a game first.');
    assert(this.players.size > 0, 'NO_PLAYERS', 'There are no players to restart with.');
    this._clearTimer();
    this.ending = false;
    this.paused = false;
    this.pauseRemainingMs = null;
    this.final = null;
    this.winnerTeamId = null;
    this.shots = [];
    this.askedCount = 0;
    this.round = null;
    this.deck = shuffle(this.store.ids(), this.rng);

    for (const grid of this.grids.values()) {
      grid.placeRandom(this.rng);
    }
    for (const team of this.teams) {
      team.score = 0;
      team.missiles = 0;
      team.eliminated = false;
      team.stats = {
        correctAnswers: 0,
        missilesEarned: 0,
        missilesFired: 0,
        hits: 0,
        misses: 0,
        shipsSunk: 0,
        shipsLost: 0,
      };
    }
    for (const player of this.players.values()) {
      player.round = null;
      player.totals = { answers: 0, correct: 0 };
      player.nonces = [];
    }

    this.phase = PHASES.BATTLE;
    this.touch();
    this.askNextQuestion();
  }

  newGame() {
    this._clearTimer();
    const oldPlayers = [...this.players.values()];
    this.phase = PHASES.LOBBY;
    this.paused = false;
    this.ending = false;
    this.phaseEndsAt = null;
    this.pauseRemainingMs = null;
    this.round = null;
    this.shots = [];
    this.deck = [];
    this.askedCount = 0;
    this.final = null;
    this.winnerTeamId = null;
    this.code = makeCode();
    this.rebuild();
    for (const player of oldPlayers) this.emit('kick', { playerId: player.id, reason: 'new-game' });
    this.emit('toast', { level: 'reset', message: 'A new game has been created.' });
    this.touch();
  }

  // ------------------------------------------------------------- host tools

  hostAwardMissiles(teamId, delta = 1) {
    const team = this.getTeam(teamId);
    assert(team, 'INVALID_TEAM', 'Team not found.');
    const amount = toInt(delta, 1);
    const cap = this.settings.missileCap;
    const next = clamp(team.missiles + amount, 0, cap > 0 ? cap : 99);
    const change = next - team.missiles;
    if (change === 0) return;
    team.missiles = next;
    if (change > 0) team.stats.missilesEarned += change;
    this.emit('toast', {
      level: 'award',
      message: `${team.name} ${change > 0 ? 'gained' : 'lost'} ${Math.abs(change)} missile${Math.abs(change) === 1 ? '' : 's'}`,
    });
    this.touch();
  }

  setConnectedMany(playerIds, connected) {
    let changed = false;
    for (const id of playerIds) {
      const player = this.players.get(id);
      if (player && player.connected !== connected) {
        player.connected = connected;
        changed = true;
      }
    }
    if (changed) this.touch();
  }

  // ----------------------------------------------------------------- timers

  _schedulePhase() {
    this._clearTimer();
    if (!this.phaseEndsAt || this.paused || this.ending) return;
    const delay = Math.max(0, this.phaseEndsAt - Date.now());
    this._timer = setTimeout(() => {
      this._timer = null;
      this._advancePhase();
    }, delay);
  }

  _advancePhase() {
    try {
      if (this.paused || this.ending) return;
      if (this.phase === PHASES.QUESTION) {
        this.revealQuestion();
      } else if (this.phase === PHASES.REVEAL) {
        this.enterBattle();
      } else if (this.phase === PHASES.BATTLE) {
        if (this.settings.questionMode === QUESTION_MODES.AUTO) this.askNextQuestion();
      }
    } catch (error) {
      // A stale timer should never crash the server.
      if (!(error instanceof GameError)) console.error('[timer]', error);
    }
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  touch() {
    this.revision += 1;
    this.emit('change');
  }

  // --------------------------------------------------------------- snapshot

  toJSON() {
    return {
      version: SNAPSHOT_VERSION,
      code: this.code,
      settings: { ...this.settings, teamNames: [...this.settings.teamNames] },
      phase: this.phase,
      paused: this.paused,
      ending: this.ending,
      phaseEndsAt: this.phaseEndsAt,
      pauseRemainingMs: this.pauseRemainingMs,
      teams: this.teams.map((team) => ({ ...team, players: [...team.players], stats: { ...team.stats } })),
      players: [...this.players.values()].map((player) => ({
        ...player,
        totals: { ...player.totals },
        nonces: [...player.nonces],
        connected: false,
      })),
      grids: [...this.grids.values()].map((grid) => grid.toJSON()),
      round: this.round ? { ...this.round, question: { ...this.round.question, options: [...this.round.question.options] }, awards: [...this.round.awards] } : null,
      shots: this.shots.map((shot) => ({ ...shot })),
      deck: [...this.deck],
      askedCount: this.askedCount,
      winnerTeamId: this.winnerTeamId,
      final: this.final,
      hostTokens: [...this.hostTokens],
      teamSeq: this.teamSeq,
      seq: this.seq,
      revision: this.revision,
      savedAt: Date.now(),
    };
  }

  restore(snapshot) {
    try {
      this.code = snapshot.code || this.code;
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...snapshot.settings,
        teamNames: [...(snapshot.settings?.teamNames || DEFAULT_SETTINGS.teamNames)],
      };
      this.phase = snapshot.phase || PHASES.LOBBY;
      this.paused = Boolean(snapshot.paused);
      this.ending = Boolean(snapshot.ending);
      this.phaseEndsAt = snapshot.phaseEndsAt ?? null;
      this.pauseRemainingMs = snapshot.pauseRemainingMs ?? null;
      this.teams = (snapshot.teams ?? []).map((team) => ({
        ...team,
        players: [...(team.players ?? [])],
        stats: { ...(team.stats ?? {}) },
      }));
      this.players = new Map((snapshot.players ?? []).map((player) => [
        player.id,
        {
          ...player,
          connected: false,
          round: player.round ?? null,
          totals: { ...(player.totals ?? { answers: 0, correct: 0 }) },
          nonces: [...(player.nonces ?? [])],
        },
      ]));
      this.grids = new Map((snapshot.grids ?? []).map((grid) => {
        const restored = Grid.fromJSON(grid);
        return [restored.id, restored];
      }));
      this.round = snapshot.round
        ? { ...snapshot.round, question: { ...snapshot.round.question, options: [...snapshot.round.question.options] }, awards: [...(snapshot.round.awards ?? [])] }
        : null;
      this.shots = (snapshot.shots ?? []).map((shot) => ({ ...shot }));
      this.deck = [...(snapshot.deck ?? [])];
      this.askedCount = snapshot.askedCount ?? 0;
      this.winnerTeamId = snapshot.winnerTeamId ?? null;
      this.final = snapshot.final ?? null;
      this.hostTokens = new Set(snapshot.hostTokens ?? []);
      this.teamSeq = snapshot.teamSeq ?? this.teams.length;
      this.seq = snapshot.seq ?? 0;
      this.revision = snapshot.revision ?? 0;
      this._timer = null;
    } catch (error) {
      console.error('[restore] Failed to restore snapshot, starting fresh:', error);
      this.teams = [];
      this.players = new Map();
      this.grids = new Map();
      this.phase = PHASES.LOBBY;
      this.rebuild();
    }
  }

  /** Resume phase timers after a restart. */
  resumeAfterRestore() {
    if (this.phase === PHASES.ENDED) return;
    if (this.ending) {
      this._finishSoon(this.final?.reason || 'interrupted');
      return;
    }
    if (this.phaseEndsAt && !this.paused) {
      if (this.phaseEndsAt <= Date.now()) {
        this.phaseEndsAt = Date.now() + 500;
      }
      this._schedulePhase();
    }
  }
}
