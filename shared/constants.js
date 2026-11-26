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
  FLEET: 'fleet',
});

export const ROLES = Object.freeze({
  PLAYER: 'player',
});

export const TEAM_COLORS = Object.freeze(['#19e3ff', '#ff3d9a', '#7dff6b']);
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
    label: 'TEAM VS TEAM',
    short: 'team v team',
    teams: Object.freeze(['ALPHA', 'BRAVO']),
    perTeam: 20,
    versusCpu: false,
    // Bigger teams need more correct answers per missile (see perMissileFor).
    scaleByTeamSize: true,
    blurb: 'Two teams of up to 20 head to head. Bigger teams need more correct answers per missile, so size is fair. A captain fires for each team.',
  }),
  fleet: Object.freeze({
    id: 'fleet',
    label: '3 TEAMS',
    short: '3 teams',
    teams: Object.freeze(['ALPHA', 'BRAVO', 'CHARLIE']),
    perTeam: 20,
    versusCpu: false,
    // Bigger teams need more correct answers per missile (see perMissileFor).
    scaleByTeamSize: true,
    blurb: 'Three teams of up to 20. Bigger teams need more correct answers per missile, so size is fair. Last fleet afloat wins.',
  }),
});

/** Correct answers per missile for a team of one player, and for a full team. */
export const PER_MISSILE_SOLO = 1;
export const PER_MISSILE_FULL = 5;

/**
 * Correct answers a team needs for one missile. In the team modes this scales
 * with the team's own size: 1 for a lone player up to 5 for a full team of 20,
 * so every player's answers are worth about the same whatever the team sizes.
 * sizes maps team id to its current player count. A config may carry its own
 * correctPerMissile, which only tests use; players can never set it.
 */
export function perMissileFor(config, teamId, sizes = {}) {
  const own = Number(config?.correctPerMissile);
  if (Number.isFinite(own) && own >= 1) return Math.floor(own);
  const preset = MODE_PRESETS[config?.mode];
  if (!preset?.scaleByTeamSize) return 1;
  const size = Math.max(1, Number(sizes[teamId]) || 1);
  const full = Math.max(2, Number(preset.perTeam) || 20);
  const t = Math.min(1, (size - 1) / (full - 1));
  return Math.max(1, Math.round(PER_MISSILE_SOLO + t * (PER_MISSILE_FULL - PER_MISSILE_SOLO)));
}

export const MODE_LIST = Object.freeze([
  MODE_PRESETS.duel,
  MODE_PRESETS.cpu,
  MODE_PRESETS.fleet,
]);

export const QUESTION_SET_IDS = Object.freeze(['easy', 'complex']);

export const QUESTION_SET_LABELS = Object.freeze({
  easy: 'ESSENTIALS',
  complex: 'ADVANCED',
});

/** Topics always offered in settings, even before a list has been added to them. */
export const DEFAULT_TOPICS = Object.freeze(['Cyber', 'CISM', 'Office Worker', 'General Knowledge', 'Films', 'Music', 'News']);
export const MAX_TOPIC_LENGTH = 30;
export const MAX_SELECTED_LISTS = 50;

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
  joinCodeLength: 3,
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

/** Game-summary awards. Accuracy needs a fair number of answers behind it. */
export const AWARDS = Object.freeze({
  minAnswersForAccuracy: 5,
});

export const SCORING = Object.freeze({
  correct: 10,
  hit: 25,
  sunk: 50,
  missilesPerCorrect: 1,
  // Answering this many in a row earns bonus missiles, up to and including the
  // answer that makes the streak this long. Longer streaks earn nothing extra.
  streakBonusFrom: 3,
  streakBonusThrough: 5,
  streakBonusMissiles: 1,
});

export const TIMING = Object.freeze({
  answerGraceMs: 1500,
  minBattleMs: 3000,
  feedbackMs: 1900, // wrong answers: long enough to read the right answer
  correctFeedbackMs: 1300,
  bonusFeedbackMs: 2300,
  // From this many wrong answers in a row, each further wrong one locks the
  // player out of answering for penaltyMs after the feedback screen.
  wrongStreakPenaltyFrom: 3,
  penaltyMs: 2000,
  penaltyGraceMs: 250,
  captainSwapMs: 30_000,
  // The incoming and outgoing captain are told this long before controls change hands.
  captainWarnMs: 5_000,
  // How long the regroup and end videos cover the big screen (phones show the captain meanwhile).
  regroupSceneMs: 6_000,
  endSceneMs: 13_000,
});

export const DEFAULT_CONFIG = Object.freeze({
  mode: MODES.DUEL,
  quizMinutes: 2,
  battleSeconds: 60,
  gridSize: 10,
  questionSets: Object.freeze(['easy']),
  soundEnabled: true,
});

export const CODE_ALPHABET = '0123456789';

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
