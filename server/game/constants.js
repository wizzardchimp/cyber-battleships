/**
 * Shared game constants and default configuration.
 * Kept dependency-free so it can be imported by tests and, where useful,
 * mirrored by the client.
 */

export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  QUESTION: 'question',
  REVEAL: 'reveal',
  BATTLE: 'battle',
  ENDED: 'ended',
});

export const MODES = Object.freeze({
  TEAMS: 'teams',
  INDIVIDUAL: 'individual',
});

export const AWARD_MODES = Object.freeze({
  FIRST: 'first',
  ALL: 'all',
});

export const QUESTION_MODES = Object.freeze({
  MANUAL: 'manual',
  AUTO: 'auto',
});

/** Traditional Battleships fleet. Order matters for the ship list UI. */
export const FLEET_TEMPLATE = Object.freeze([
  { key: 'carrier', name: 'Aircraft Carrier', length: 5 },
  { key: 'battleship', name: 'Battleship', length: 4 },
  { key: 'cruiser', name: 'Cruiser', length: 3 },
  { key: 'submarine', name: 'Submarine', length: 3 },
  { key: 'destroyer', name: 'Destroyer', length: 2 },
]);

export const FLEET_TOTAL_CELLS = FLEET_TEMPLATE.reduce((sum, ship) => sum + ship.length, 0);

export const GRID_COLS = 10;
export const GRID_ROWS = 10;
export const COLUMN_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

export const TEAM_COLORS = ['#25e6ff', '#ff4d6d', '#7dff6b', '#ffc857', '#c084fc', '#38bdf8'];

export const POINTS = Object.freeze({
  correct: 10,
  firstBonus: 5,
  hit: 25,
  sunk: 100,
});

export const DEFAULT_SETTINGS = Object.freeze({
  gridCount: 2,
  mode: MODES.TEAMS,
  maxPerTeam: 6,
  maxPlayers: 24,
  awardMode: AWARD_MODES.FIRST,
  maxAttempts: 1,
  missileCap: 0, // 0 = unlimited
  missilesRetained: true,
  questionSeconds: 30, // 0 = no timer
  revealSeconds: 10,
  autoIntervalSeconds: 30,
  questionMode: QUESTION_MODES.MANUAL,
  allowLateJoin: true,
  soundOn: true,
  teamNames: ['ALPHA', 'BRAVO', 'CHARLIE'],
});

export const LIMITS = Object.freeze({
  maxTeams: 6,
  maxGridCount: 3,
  minNameLength: 2,
  maxNameLength: 20,
  maxTeamNameLength: 16,
  maxQuestionLength: 400,
  maxOptionLength: 200,
  maxExplanationLength: 800,
  maxQuestionSeconds: 300,
  maxAttempts: 3,
});

/** Error type understood by the socket layer and surfaced to clients. */
export class GameError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'GameError';
    this.code = code;
  }
}

/** Assertion helper that throws a GameError with a client-safe message. */
export function assert(condition, code, message) {
  if (!condition) throw new GameError(code, message);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function coordName(col, row) {
  return `${COLUMN_LABELS[col] ?? '?'}${row + 1}`;
}
