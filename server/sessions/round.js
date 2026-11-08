import crypto from 'node:crypto';

import {
  FLEET_TEMPLATE,
  MODES,
  PHASES,
  ROLES,
  TEAM_COLORS,
} from '../../shared/constants.js';

export const CPU_ID = 'cpu';
export const CPU_NAME = 'CPU FIREWALL';

export function cellKey(x, y) {
  return `${x},${y}`;
}

export function emptyScore() {
  return {
    points: 0,
    hits: 0,
    misses: 0,
    sunk: 0,
    correct: 0,
    answered: 0,
    missilesEarned: 0,
  };
}

export function ensureScore(state, ownerId) {
  if (!state.scores[ownerId]) state.scores[ownerId] = emptyScore();
  return state.scores[ownerId];
}

/** Build a random, non-overlapping fleet for a square grid. */
export function randomFleet(gridSize) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const occupied = new Set();
    const ships = [];
    let failed = false;

    for (const template of FLEET_TEMPLATE) {
      let placed = null;
      for (let tries = 0; tries < 300 && !placed; tries += 1) {
        const horizontal = Math.random() < 0.5;
        const maxX = horizontal ? gridSize - template.length : gridSize - 1;
        const maxY = horizontal ? gridSize - 1 : gridSize - template.length;
        const x = Math.floor(Math.random() * (maxX + 1));
        const y = Math.floor(Math.random() * (maxY + 1));
        const cells = Array.from({ length: template.length }, (_, index) => ({
          x: horizontal ? x + index : x,
          y: horizontal ? y : y + index,
        }));
        if (cells.some((cell) => occupied.has(cellKey(cell.x, cell.y)))) continue;
        placed = { ...template, cells };
      }
      if (!placed) {
        failed = true;
        break;
      }
      for (const cell of placed.cells) occupied.add(cellKey(cell.x, cell.y));
      ships.push({
        key: placed.key,
        name: placed.name,
        length: placed.length,
        cells: placed.cells,
        hits: 0,
        sunk: false,
      });
    }

    if (!failed) return ships;
  }

  // Extremely unlikely fallback: deterministic horizontal placement.
  const fallback = [];
  let cursor = 0;
  for (const template of FLEET_TEMPLATE) {
    const cells = Array.from({ length: template.length }, (_, index) => ({
      x: (cursor + index) % gridSize,
      y: Math.floor((cursor + index) / gridSize),
    }));
    cursor += template.length;
    fallback.push({ ...template, cells, hits: 0, sunk: false });
  }
  return fallback;
}

export function makeFleet(gridSize) {
  return {
    gridSize,
    ships: randomFleet(gridSize),
    shots: [],
  };
}

/**
 * Combatants are the things that own a fleet and a score.
 * Team and co-op modes use teams; free-for-all uses individual players.
 * A CPU firewall is added whenever there is no human opponent.
 */
export function buildCombatants(state) {
  const mode = state.config.mode;
  const teams = [...state.teams].sort((a, b) => a.sortOrder - b.sortOrder);
  const players = state.players.filter((player) => player.role === ROLES.PLAYER);

  if (mode === MODES.INDIVIDUAL) {
    const combatants = players.map((player, index) => ({
      id: player.id,
      kind: 'player',
      name: player.displayName,
      color: TEAM_COLORS[index % TEAM_COLORS.length],
      teamId: null,
      playerId: player.id,
      targetId: null,
    }));
    return linkTargets(combatants, false);
  }

  const combatants = teams.map((team, index) => ({
    id: team.id,
    kind: 'team',
    name: team.name,
    color: team.color || TEAM_COLORS[index % TEAM_COLORS.length],
    teamId: team.id,
    playerId: null,
    targetId: null,
  }));
  return linkTargets(combatants, mode === MODES.COOPERATIVE);
}

/**
 * Teams form a targeting ring; free-for-all players do the same. In co-op
 * every human crew targets the shared CPU grid. A single human combatant is
 * always given the CPU as a target so the round remains playable.
 */
function linkTargets(combatants, alwaysCpu) {
  if (combatants.length === 0) {
    if (!alwaysCpu) return combatants;
    return [
      {
        id: CPU_ID,
        kind: 'cpu',
        name: CPU_NAME,
        color: TEAM_COLORS[4],
        teamId: null,
        playerId: null,
        targetId: null,
      },
    ];
  }

  const needsCpu = alwaysCpu || combatants.length === 1;
  let all = combatants;
  if (needsCpu) {
    all = [
      ...combatants,
      {
        id: CPU_ID,
        kind: 'cpu',
        name: CPU_NAME,
        color: TEAM_COLORS[4],
        teamId: null,
        playerId: null,
        targetId: null,
      },
    ];
  }

  const humans = all.filter((combatant) => combatant.kind !== 'cpu');
  if (alwaysCpu) {
    for (const combatant of humans) combatant.targetId = CPU_ID;
    return all;
  }

  if (humans.length === 1) {
    humans[0].targetId = CPU_ID;
    const cpu = all.find((entry) => entry.id === CPU_ID);
    if (cpu) cpu.targetId = humans[0].id;
    return all;
  }

  for (let index = 0; index < humans.length; index += 1) {
    humans[index].targetId = humans[(index + 1) % humans.length].id;
  }
  return all;
}

export function ownerForPlayer(state, player) {
  if (!player || player.role !== ROLES.PLAYER) return null;
  if (state.config.mode === MODES.INDIVIDUAL) return player.id;
  return player.teamId || null;
}

/**
 * Insert a late joiner into the existing targeting ring without disturbing any
 * other player's target. Used for individual-mode rounds that are already live.
 */
export function linkLateCombatant(combatants, combatant) {
  const others = combatants.filter(
    (entry) => entry.kind !== 'cpu' && entry.id !== combatant.id,
  );
  const cpu = combatants.find((entry) => entry.kind === 'cpu');

  if (others.length === 0) {
    if (cpu) {
      combatant.targetId = cpu.id;
      cpu.targetId = combatant.id;
      return combatant;
    }
    const newCpu = {
      id: CPU_ID,
      kind: 'cpu',
      name: CPU_NAME,
      color: TEAM_COLORS[4],
      teamId: null,
      playerId: null,
      targetId: combatant.id,
    };
    combatants.push(newCpu);
    combatant.targetId = newCpu.id;
    return combatant;
  }

  const anchor = others.find((entry) => entry.targetId) || others[0];
  const previousTarget = anchor.targetId;
  combatant.targetId =
    previousTarget && previousTarget !== combatant.id ? previousTarget : anchor.id;
  anchor.targetId = combatant.id;
  return combatant;
}

/**
 * Make sure a player who joins a live round owns a fleet, score and arsenal.
 * Team modes already have a team combatant; free-for-all adds one on the fly.
 */
export function ensureLateCombatant(state, player) {
  const round = state.round;
  if (!round) return null;
  const ownerId = ownerForPlayer(state, player);
  if (!ownerId) return null;

  let combatant = round.combatants.find((entry) => entry.id === ownerId) || null;
  if (combatant) {
    ensureScore(state, ownerId);
    if (state.arsenal[ownerId] === undefined) state.arsenal[ownerId] = 0;
    return combatant;
  }

  combatant = {
    id: ownerId,
    kind: 'player',
    name: player.displayName,
    color: TEAM_COLORS[round.combatants.filter((entry) => entry.kind === 'player').length % TEAM_COLORS.length],
    teamId: null,
    playerId: player.id,
    targetId: null,
  };
  round.combatants.push(combatant);
  state.fleets[ownerId] = makeFleet(state.config.gridSize);
  ensureScore(state, ownerId);
  state.arsenal[ownerId] = 0;
  linkLateCombatant(round.combatants, combatant);
  return combatant;
}

export function ownerName(state, ownerId) {
  const combatant = state.round?.combatants?.find((entry) => entry.id === ownerId);
  if (combatant) return combatant.name;
  if (ownerId === CPU_ID) return CPU_NAME;
  const team = state.teams.find((entry) => entry.id === ownerId);
  if (team) return team.name;
  const player = state.players.find((entry) => entry.id === ownerId);
  return player?.displayName || 'Unknown';
}

export function makeRound({ state, number, question, now, quizEndsAt, combatants }) {
  return {
    number,
    phase: PHASES.QUESTION,
    startedAt: new Date(now).toISOString(),
    quizEndsAt: new Date(quizEndsAt).toISOString(),
    questionNumber: 0,
    question: null,
    answers: {},
    combatants,
    attacks: [],
    attackStartedAt: null,
    attackEndsAt: null,
    endedAt: null,
    outcome: null,
    results: [],
  };
}

export function makeQuestionState(question, number, now, endsAt) {
  return {
    id: question.id,
    number,
    category: question.category,
    difficulty: question.difficulty,
    prompt: question.prompt,
    options: [...question.options],
    answerIndex: question.answerIndex,
    explanation: question.explanation,
    startedAt: new Date(now).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    revealedAt: null,
    revealUntil: null,
  };
}

/** Attach the question to a round without leaking the answer. */
export function questionForClient(question, { reveal = false } = {}) {
  if (!question) return null;
  return {
    id: question.id,
    number: question.number,
    category: question.category,
    difficulty: question.difficulty,
    prompt: question.prompt,
    options: [...question.options],
    startedAt: question.startedAt,
    endsAt: question.endsAt,
    revealed: Boolean(question.revealedAt),
    revealUntil: question.revealUntil,
    ...(reveal ? { answerIndex: question.answerIndex, explanation: question.explanation } : {}),
  };
}

export function attackId() {
  return `a_${crypto.randomUUID()}`;
}
