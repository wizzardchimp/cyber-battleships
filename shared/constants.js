/**
 * Shared constants used by the server, browser clients and tests.
 * The server remains authoritative; clients use these only for labels,
 * defaults and form validation.
 */

export const APP_NAME = 'CYBER BATTLESHIPS';
export const APP_TAGLINE = 'CYBER COMMAND // LIVE OPERATIONS';

export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  MISSION_READY: 'mission_ready',
  QUESTION: 'question',
  ATTACK: 'attack',
  ROUND_OVER: 'round_over',
  ENDED: 'ended',
});

export const MODES = Object.freeze({
  TEAM: 'team',
  INDIVIDUAL: 'individual',
  COOPERATIVE: 'cooperative',
});

export const ROLES = Object.freeze({
  PLAYER: 'player',
  SPECTATOR: 'spectator',
});

export const AGE_GROUPS = Object.freeze([
  { value: '10-15', label: 'Cadets (10–15)' },
  { value: '15-20', label: 'Juniors (15–20)' },
  { value: 'adult', label: 'Adults (21+)' },
]);

export const DIFFICULTIES = Object.freeze([
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
  { value: 'expert', label: 'Expert' },
]);

export const TEAM_COLORS = Object.freeze([
  '#25e6ff',
  '#ff4d6d',
  '#7dff6b',
  '#ffc857',
  '#c084fc',
  '#38bdf8',
]);

export const DEFAULT_TEAM_NAMES = Object.freeze([
  'ALPHA',
  'BRAVO',
  'CHARLIE',
  'DELTA',
  'ECHO',
  'FOXTROT',
]);

export const FLEET_TEMPLATE = Object.freeze([
  { key: 'carrier', name: 'Aircraft Carrier', length: 5 },
  { key: 'battleship', name: 'Battleship', length: 4 },
  { key: 'cruiser', name: 'Cruiser', length: 3 },
  { key: 'submarine', name: 'Submarine', length: 3 },
  { key: 'destroyer', name: 'Destroyer', length: 2 },
]);

export const LIMITS = Object.freeze({
  minNameLength: 2,
  maxNameLength: 20,
  maxTeamNameLength: 16,
  maxSessionNameLength: 40,
  minTeams: 1,
  maxTeams: 6,
  maxPlayersPerTeam: 20,
  maxPlayersTotal: 100,
  minQuestionTimer: 5,
  maxQuestionTimer: 120,
  minRoundMinutes: 1,
  maxRoundMinutes: 10,
  maxAttacksPerTeam: 10,
  maxTacticalSeconds: 120,
  minGridSize: 8,
  maxGridSize: 12,
  joinCodeLength: 6,
  hostCookieHours: 12,
  sessionRetentionHours: 24,
  reconnectGraceMs: 8000,
});

export const DEFAULT_CONFIG = Object.freeze({
  name: 'CYBER BATTLESHIPS',
  mode: MODES.TEAM,
  teamCount: 2,
  teamNames: ['ALPHA', 'BRAVO'],
  maxPlayersPerTeam: 8,
  maxPlayersTotal: 60,
  allowSpectators: true,
  allowLateJoin: true,
  gridSize: 10,
  fleet: 'standard',
  questionTimer: 20,
  roundMinutes: 2,
  maxAttacksPerTeam: 3,
  tacticalSeconds: 30,
  ammoCarryOver: true,
  specialWeapons: false,
  ageGroup: '15-20',
  difficulty: 'medium',
  lobbyLocked: false,
  soundEnabled: true,
});

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const PHASE_LABELS = Object.freeze({
  lobby: 'LOBBY',
  mission_ready: 'MISSION READY',
  question: 'QUESTION',
  attack: 'ATTACK',
  round_over: 'ROUND OVER',
  ended: 'OPERATION COMPLETE',
});

export const MODE_LABELS = Object.freeze({
  team: 'TEAM VS TEAM',
  individual: 'FREE-FOR-ALL',
  cooperative: 'CO-OP VS CPU',
});

export const ACHIEVEMENTS = Object.freeze({
  CYBER_EXPERT: { key: 'cyber_expert', name: 'Cyber Expert', description: '10 correct answers in a row' },
  QUICK_DRAW: { key: 'quick_draw', name: 'Quick Draw', description: 'Answer correctly in under 3 seconds' },
  DEADLY_ACCURACY: { key: 'deadly_accuracy', name: 'Deadly Accuracy', description: 'Score 3 successful hits' },
  TEAM_PLAYER: { key: 'team_player', name: 'Team Player', description: 'Contribute 10 missiles' },
  SHIP_WRECKER: { key: 'ship_wrecker', name: 'Ship Wrecker', description: 'Destroy an entire ship' },
  COMEBACK_KING: { key: 'comeback_king', name: 'Comeback King', description: 'Help your team recover from behind' },
});

export const MISSILE_REWARDS = Object.freeze([
  { maxSeconds: 5, missiles: 3 },
  { maxSeconds: 10, missiles: 2 },
  { maxSeconds: 20, missiles: 1 },
]);

/** Seconds the correct answer stays on screen before the next question. */
export const ROUND_REVEAL_SECONDS = 4;

/** Minimum attack window even when the facilitator configures zero seconds. */
export const MIN_ATTACK_SECONDS = 10;

export const ROUND_PHASES = Object.freeze([
  PHASES.QUESTION,
  PHASES.ATTACK,
  PHASES.ROUND_OVER,
]);

export function isRoundPhase(phase) {
  return ROUND_PHASES.includes(phase);
}

export function missileRewardFor(seconds) {
  const reward = MISSILE_REWARDS.find((entry) => seconds <= entry.maxSeconds);
  return reward ? reward.missiles : 1;
}

export function phaseLabel(phase) {
  return PHASE_LABELS[phase] || String(phase || '').toUpperCase();
}

export function modeLabel(mode) {
  return MODE_LABELS[mode] || String(mode || '').toUpperCase();
}
