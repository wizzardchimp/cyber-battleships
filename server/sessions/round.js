import crypto from 'node:crypto';

import {
  CPU_COLOR,
  FLEET_TEMPLATE,
  MODE_PRESETS,
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

export function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
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

  // Extremely unlikely fallback: deterministic placement row by row.
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

/** The sides for a mode, ready to be stored on the session. */
export function buildTeams(mode, now = new Date().toISOString()) {
  const preset = MODE_PRESETS[mode] || MODE_PRESETS.squad;
  return preset.teams.map((name, index) => ({
    id: `t_${crypto.randomUUID()}`,
    name,
    color: TEAM_COLORS[index % TEAM_COLORS.length],
    sortOrder: index,
    maxPlayers: preset.perTeam,
    captainPlayerId: null,
    targetTeamId: null,
    missiles: 0,
    weapons: {},
    eliminated: false,
    stats: {},
    createdAt: now,
  }));
}

/**
 * Everything that owns a fleet. Each human side targets the other side; in
 * "everyone vs CPU" the single crew targets the CPU firewall.
 */
export function buildCombatants(state) {
  const preset = MODE_PRESETS[state.config.mode] || MODE_PRESETS.squad;
  const teams = [...state.teams].sort((a, b) => a.sortOrder - b.sortOrder);
  const combatants = teams.map((team) => ({
    id: team.id,
    kind: 'team',
    name: team.name,
    color: team.color,
    teamId: team.id,
    targetId: null,
    targetIds: [],
  }));

  if (preset.versusCpu) {
    for (const combatant of combatants) {
      combatant.targetId = CPU_ID;
      combatant.targetIds = [CPU_ID];
    }
    combatants.push({
      id: CPU_ID,
      kind: 'cpu',
      name: CPU_NAME,
      color: CPU_COLOR,
      teamId: null,
      targetId: null,
      targetIds: [],
    });
    return combatants;
  }

  // Every side may attack every other side. The first is the default target.
  for (let index = 0; index < combatants.length; index += 1) {
    const others = combatants.slice(index + 1).concat(combatants.slice(0, index));
    combatants[index].targetIds = others.map((entry) => entry.id);
    combatants[index].targetId = others[0]?.id || null;
  }
  return combatants;
}

export function makeRound({ number, now, quizEndsAt, combatants }) {
  return {
    number,
    startedAt: new Date(now).toISOString(),
    quizEndsAt: new Date(quizEndsAt).toISOString(),
    battleStartedAt: null,
    battleEndsAt: null,
    endedAt: null,
    combatants,
    attacks: [],
    quiz: {},
    outcome: null,
    results: [],
  };
}

/** Question as the player sees it: never includes the answer. */
export function questionForPlayer(current) {
  if (!current) return null;
  return {
    number: current.number,
    category: current.category,
    prompt: current.prompt,
    options: [...current.options],
  };
}
