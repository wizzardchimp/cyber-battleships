import { PHASES, correctPerMissile } from '../../shared/constants.js';
import { shortJoinUrlFor } from '../util/security.js';
import { CPU_ID, questionForPlayer } from './round.js';

function safeConfig(config) {
  return {
    mode: config.mode,
    quizMinutes: config.quizMinutes,
    battleSeconds: config.battleSeconds,
    gridSize: config.gridSize,
    questionSet: config.questionSet,
    soundEnabled: config.soundEnabled,
  };
}

function rosterFor(session, teamId) {
  const captainId = session.teamById(teamId)?.captainPlayerId || null;
  return session.playersOnTeam(teamId)
    .map((player) => ({
      id: player.id,
      name: player.displayName,
      connected: Boolean(player.connected),
      captain: player.id === captainId && session.state.phase !== PHASES.LOBBY,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function scoreFor(session, combatant) {
  const state = session.state;
  const score = state.scores?.[combatant.id] || {};
  const fleet = state.fleets?.[combatant.id];
  const shipsTotal = fleet?.ships?.length || 0;
  const shipsSunk = fleet?.ships?.filter((ship) => ship.sunk).length || 0;
  return {
    id: combatant.id,
    name: combatant.name,
    color: combatant.color,
    kind: combatant.kind,
    points: Number(score.points) || 0,
    hits: Number(score.hits) || 0,
    misses: Number(score.misses) || 0,
    sunk: Number(score.sunk) || 0,
    correct: Number(score.correct) || 0,
    answered: Number(score.answered) || 0,
    missiles: combatant.kind === 'cpu' ? 0 : session.arsenalFor(combatant.id),
    ammoProgress: Number(state.ammoProgress?.[combatant.id]) || 0,
    perMissile: correctPerMissile(state.config.mode),
    eliminated: shipsTotal > 0 && shipsSunk >= shipsTotal,
    shipsTotal,
    shipsSunk,
  };
}

/** Shots are always visible; ship positions only once the game is over. */
function boardFor(session, combatant, { revealShips }) {
  const state = session.state;
  const fleet = state.fleets?.[combatant.id];
  const base = {
    id: combatant.id,
    name: combatant.name,
    color: combatant.color,
    kind: combatant.kind,
    gridSize: fleet?.gridSize || state.config.gridSize,
    shots: (fleet?.shots || []).map((shot) => ({ x: shot.x, y: shot.y, hit: Boolean(shot.hit), by: shot.by || null })),
    shipsTotal: fleet?.ships?.length || 0,
    shipsSunk: fleet?.ships?.filter((ship) => ship.sunk).length || 0,
    sunkShips: (fleet?.ships || []).filter((ship) => ship.sunk).map((ship) => ship.name),
  };
  if (!revealShips || !fleet) return base;
  return {
    ...base,
    ships: fleet.ships.map((ship) => ({
      key: ship.key,
      name: ship.name,
      length: ship.length,
      cells: ship.cells,
      sunk: Boolean(ship.sunk),
    })),
  };
}

function roundProjection(session) {
  const state = session.state;
  const round = state.round;
  if (!round) return null;
  const revealShips = state.phase === PHASES.RESULT;
  return {
    number: round.number,
    cycle: round.cycle || 1,
    quizEndsAt: round.quizEndsAt,
    battleEndsAt: round.battleEndsAt,
    battleEndReason: round.battleEndReason || null,
    captainSwapAt: state.phase === PHASES.BATTLE ? round.captainSwapAt || null : null,
    teams: session.teamProgress(),
    combatants: round.combatants.map((combatant) => ({
      id: combatant.id,
      name: combatant.name,
      color: combatant.color,
      kind: combatant.kind,
      targetId: combatant.targetId || null,
      targetIds: combatant.targetIds?.length ? combatant.targetIds : [combatant.targetId].filter(Boolean),
    })),
    scores: round.combatants.map((combatant) => scoreFor(session, combatant)),
    boards: round.combatants.map((combatant) => boardFor(session, combatant, { revealShips })),
    shotsFired: round.attacks.length,
    outcome: round.outcome || null,
  };
}

/**
 * Public state is shown on the projector and mirrors. It is built from
 * explicit fields, never by spreading the session snapshot, so token hashes,
 * the control key and answer keys cannot leak.
 */
export function publicProjection(session, { control = false } = {}) {
  const state = session.state;
  const teams = [...state.teams]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((team) => {
      const roster = rosterFor(session, team.id);
      return {
        id: team.id,
        name: team.name,
        color: team.color,
        maxPlayers: team.maxPlayers,
        playerCount: roster.length,
        connectedCount: roster.filter((entry) => entry.connected).length,
        eliminated: Boolean(team.eliminated),
        players: roster,
      };
    });
  const playerCount = state.players.length;

  return {
    session: {
      id: state.id,
      joinCode: state.joinCode,
      phase: state.phase,
      mode: state.config.mode,
      config: safeConfig(state.config),
    },
    teams,
    counts: {
      players: playerCount,
      connected: state.players.filter((player) => player.connected).length,
      capacity: session.capacity(),
    },
    join: {
      code: state.joinCode,
      url: shortJoinUrlFor(state.joinBaseUrl, state.joinCode),
      qrUrl: `/api/sessions/${encodeURIComponent(state.joinCode)}/qr.svg`,
    },
    questionSets: session.questions.summaries(),
    round: roundProjection(session),
    viewer: { control: Boolean(control) },
    meta: {
      serverNow: Date.now(),
      version: state.version,
      phase: state.phase,
    },
  };
}

export function playerProjection(session, playerId) {
  const state = session.state;
  const publicState = publicProjection(session);
  const player = session.playerById(playerId);
  if (!player) return { ...publicState, me: null };

  const team = session.teamById(player.teamId);
  const round = publicState.round;
  const me = {
    id: player.id,
    name: player.displayName,
    teamId: player.teamId || null,
    teamName: team?.name || null,
    teamColor: team?.color || null,
    connected: Boolean(player.connected),
  };

  if (round) {
    const entry = state.round.quiz?.[player.id] || {};
    const combatant = state.round.combatants.find((item) => item.id === player.teamId) || null;
    const targetId = combatant?.targetId || null;
    const targetIds = combatant?.targetIds?.length ? combatant.targetIds : [targetId].filter(Boolean);
    const targetCombatant = state.round.combatants.find((item) => item.id === targetId) || null;
    const revealShips = state.phase === PHASES.RESULT;

    const captain = team ? session.playerById(team.captainPlayerId) : null;
    round.me = {
      isCaptain: Boolean(captain && captain.id === player.id),
      captainName: captain?.displayName || null,
      missiles: team ? session.arsenalFor(team.id) : 0,
      answered: entry.answered || 0,
      correct: entry.correct || 0,
      question:
        state.phase === PHASES.QUIZ && !session.fleetDestroyed(player.teamId)
          ? questionForPlayer(entry.current)
          : null,
      targetId,
      targetName: targetCombatant?.name || null,
      targetBoard:
        targetCombatant &&
        (state.phase === PHASES.BATTLE || state.phase === PHASES.RESUPPLY || revealShips)
          ? boardFor(session, targetCombatant, { revealShips })
          : null,
      isCpuTarget: targetId === CPU_ID,
      targetIds,
      eliminated: session.fleetDestroyed(player.teamId),
      ammoProgress: team ? Number(state.ammoProgress?.[team.id]) || 0 : 0,
      perMissile: correctPerMissile(state.config.mode),
      targetBoards:
        state.phase === PHASES.BATTLE || state.phase === PHASES.RESUPPLY || revealShips
          ? targetIds
              .map((id) => state.round.combatants.find((item) => item.id === id))
              .filter(Boolean)
              .map((item) => boardFor(session, item, { revealShips }))
          : [],
    };
    // Players only need their own side's board and scores; keep payloads small.
    round.boards = round.boards.filter((board) => board.id === player.teamId || targetIds.includes(board.id));
  }

  return { ...publicState, round, me };
}
