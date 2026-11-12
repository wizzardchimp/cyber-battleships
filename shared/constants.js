/**
 * Shared constants used by the server, browser clients and tests.
 * The server remains authoritative; clients use these only for labels,
 * defaults and form validation.
 */

export const APP_NAME = 'CYBER BATTLESHIPS';
export const APP_TAGLINE = 'LIVE CYBER DEFENCE TRAINING';

export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  QUIZ: 'quiz',
  REVIEW: 'review',
  BATTLE: 'battle',
  RESUPPLY: 'resupply',
  RESULT: 'result',
});

export const MODES = Object.freeze({
  CPU: 'cpu',
  DUEL: 'duel',
  SQUAD: 'squad',
});

export const ROLES = Object.freeze({
  PLAYER: 'player',
});

export const TEAM_COLORS = Object.freeze(['#19e3ff', '#ff3d9a']);
export const CPU_COLOR = '#b66dff';

export const MODE_PRESETS = Object.freeze({
  cpu: Object.freeze({
    id: 'cpu',
    label: 'EVERYONE VS CPU',
    short: 'VS CPU',
    teams: Object.freeze(['CREW']),
    perTeam: 20,
    versusCpu: true,
    blurb: 'One crew of up to 20 players works together to sink the CPU fleet.',
  }),
  duel: Object.freeze({
    id: 'duel',
    label: '1 VS 1',
    short: '1 v 1',
    teams: Object.freeze(['ALPHA', 'BRAVO']),
    perTeam: 1,
    versusCpu: false,
    blurb: 'Two players go head to head.',
  }),
  squad: Object.freeze({
    id: 'squad',
    label: '3 VS 3',
    short: '3 v 3',
    teams: Object.freeze(['ALPHA', 'BRAVO']),
    perTeam: 3,
    versusCpu: false,
    blurb: 'Two squads of three share missiles and fight for the sea.',
  }),
});

export const MODE_LIST = Object.freeze([MODE_PRESETS.squad, MODE_PRESETS.duel, MODE_PRESETS.cpu]);

export const QUESTION_SET_IDS = Object.freeze(['easy', 'complex']);

export const QUESTION_SET_LABELS = Object.freeze({
  easy: 'EASY',
  complex: 'COMPLEX',
});

export const FLEET_TEMPLATE = Object.freeze([
  { key: 'carrier', name: 'Aircraft Carrier', length: 5 },
  { key: 'battleship', name: 'Battleship', length: 4 },
  { key: 'cruiser', name: 'Cruiser', length: 3 },
  { key: 'submarine', name: 'Submarine', length: 3 },
  { key: 'destroyer', name: 'Destroyer', length: 2 },
]);

export const LIMITS = Object.freeze({
  minNameLength: 2,
  maxNameLength: 16,
  joinCodeLength: 6,
  minQuizMinutes: 1,
  maxQuizMinutes: 3,
  minBattleSeconds: 30,
  maxBattleSeconds: 180,
  minGridSize: 8,
  maxGridSize: 12,
  sessionRetentionHours: 24,
  reconnectGraceMs: 8000,
  minQuestions: 8,
  maxQuestions: 500,
  maxQuestionChars: 300,
  maxOptionChars: 150,
  maxCategoryChars: 40,
  maxExplanationChars: 300,
});

/** Every question offers exactly this many answers. */
export const OPTIONS_PER_QUESTION = 3;

export const SCORING = Object.freeze({
  correct: 10,
  hit: 25,
  sunk: 50,
  missilesPerCorrect: 1,
});

export const TIMING = Object.freeze({
  answerGraceMs: 1500,
  minBattleMs: 3000,
  feedbackMs: 1900,
});

export const DEFAULT_CONFIG = Object.freeze({
  mode: MODES.SQUAD,
  quizMinutes: 2,
  battleSeconds: 60,
  gridSize: 10,
  questionSet: 'easy',
  soundEnabled: true,
});

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const PHASE_LABELS = Object.freeze({
  lobby: 'LOBBY',
  quiz: 'QUIZ',
  review: 'BRIEFING',
  battle: 'BATTLE',
  resupply: 'RESUPPLY',
  result: 'RESULT',
});

export function phaseLabel(phase) {
  return PHASE_LABELS[phase] || String(phase || '').toUpperCase();
}

export function modeLabel(mode) {
  return MODE_PRESETS[mode]?.label || String(mode || '').toUpperCase();
}

export function setLabel(id) {
  return QUESTION_SET_LABELS[id] || String(id || '').toUpperCase();
}
