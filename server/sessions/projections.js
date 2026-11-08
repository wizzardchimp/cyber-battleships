import { PHASES, ROLES } from '../../shared/constants.js';
import { shortJoinUrlFor } from '../util/security.js';
import { questionForClient, ownerForPlayer } from './round.js';

function rosterFor(state, teamId) {
  return state.players
    .filter((player) => player.teamId === teamId && player.role === ROLES.PLAYER)
    .map((player) => ({
      id: player.id,
      name: player.displayName,
      connected: Boolean(player.connected),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function safeConfig(config) {
  return {
    name: config.name,
    mode: config.mode,
    teamCount: config.teamCount,
    maxPlayersPerTeam: config.maxPlayersPerTeam,
    maxPlayersTotal: config.maxPlayersTotal,
    allowSpectators: config.allowSpectators,
    allowLateJoin: config.allowLateJoin,
    gridSize: config.gridSize,
    fleet: config.fleet,
    questionTimer: config.questionTimer,
    roundMinutes: config.roundMinutes,
    maxAttacksPerTeam: config.maxAttacksPerTeam,
    tacticalSeconds: config.tacticalSeconds,
    ammoCarryOver: config.ammoCarryOver,
    specialWeapons: config.specialWeapons,
    ageGroup: config.ageGroup,
    difficulty: config.difficulty,
    lobbyLocked: config.lobbyLocked,
    soundEnabled: config.soundEnabled,
  };
}

function combatantScore(state, combatant) {
  const score = state.scores?.[combatant.id] || {};
  const fleet = state.fleets?.[combatant.id];
  const shipsTotal = fleet?.ships?.length || 0;
  const shipsSunk = fleet?.ships?.filter((ship) => ship.sunk).length || 0;
  return {
    id: combatant.id,
    name: combatant.name,
    color: combatant.color,
    kind: combatant.kind,
    teamId: combatant.teamId || null,
    playerId: combatant.playerId || null,
    points: Number(score.points) || 0,
    hits: Number(score.hits) || 0,
    misses: Number(score.misses) || 0,
    sunk: Number(score.sunk) || 0,
    correct: Number(score.correct) || 0,
    answered: Number(score.answered) || 0,
    missilesEarned: Number(score.missilesEarned) || 0,
    missiles: Number(state.arsenal?.[combatant.id]) || 0,
    shipsTotal,
    shipsSunk,
    shipsRemaining: shipsTotal - shipsSunk,
    eliminated: shipsTotal > 0 && shipsSunk >= shipsTotal,
  };
}

function boardFor(state, combatant, { revealShips = false } = {}) {
  const fleet = state.fleets?.[combatant.id];
  if (!fleet) {
    return {
      id: combatant.id,
      name: combatant.name,
      color: combatant.color,
      kind: combatant.kind,
      gridSize: state.config.gridSize,
      shots: [],
      shipsSunk: 0,
      shipsTotal: 0,
      ships: [],
    };
  }
  return {
    id: combatant.id,
    name: combatant.name,
    color: combatant.color,
    kind: combatant.kind,
    gridSize: fleet.gridSize,
    shots: fleet.shots.map((shot) => ({
      x: shot.x,
      y: shot.y,
      hit: Boolean(shot.hit),
      by: shot.by,
      round: shot.round,
    })),
    shipsSunk: fleet.ships.filter((ship) => ship.sunk).length,
    shipsTotal: fleet.ships.length,
    ...(revealShips
      ? {
          ships: fleet.ships.map((ship) => ({
            key: ship.key,
            name: ship.name,
            length: ship.length,
            cells: ship.cells,
            hits: ship.hits,
            sunk: Boolean(ship.sunk),
          })),
        }
      : {}),
  };
}

function answerTally(round) {
  const question = round?.question;
  if (!question) return [];
  const tally = Array.from({ length: question.options.length }, () => 0);
  for (const answer of Object.values(round.answers || {})) {
    if (answer.questionNumber !== question.number) continue;
    if (answer.optionIndex >= 0 && answer.optionIndex < tally.length) {
      tally[answer.optionIndex] += 1;
    }
  }
  return tally;
}

function roundProjection(session, { revealShips = false, revealAnswer = false, host = false } = {}) {
  const state = session.state;
  const round = state.round;
  if (!round) return null;

  const reveal = state.phase === PHASES.ROUND_OVER;
  const combatants = round.combatants || [];
  const question = round.question
    ? questionForClient(round.question, { reveal: revealAnswer || Boolean(round.question.revealedAt) })
    : null;
  const answers = Object.values(round.answers || {});
  const answered = answers.length;
  const totalPlayers = state.players.filter((player) => player.role === ROLES.PLAYER).length;
  const revealed = Boolean(round.question?.revealedAt);
  const scores = combatants.map((combatant) => combatantScore(state, combatant));
  const boards = combatants.map((combatant) =>
    boardFor(state, combatant, { revealShips: revealShips || reveal }),
  );

  return {
    number: round.number,
    phase: round.phase || state.phase,
    startedAt: round.startedAt,
    quizEndsAt: round.quizEndsAt,
    attackStartedAt: round.attackStartedAt || null,
    attackEndsAt: round.attackEndsAt || null,
    endedAt: round.endedAt || null,
    question,
    questionNumber: round.questionNumber,
    answered,
    totalPlayers,
    allAnswered: totalPlayers > 0 && answered >= totalPlayers,
    answerTally: revealed || host ? answerTally(round) : null,
    answers: host
      ? Object.fromEntries(
          Object.entries(round.answers || {}).map(([playerId, answer]) => [playerId, { ...answer }]),
        )
      : undefined,
    combatants: combatants.map((combatant) => ({
      id: combatant.id,
      name: combatant.name,
      color: combatant.color,
      kind: combatant.kind,
      teamId: combatant.teamId || null,
      playerId: combatant.playerId || null,
      targetId: combatant.targetId || null,
    })),
    scores,
    boards,
    attacks: round.attacks.map((attack) => ({
      id: attack.id,
      ownerId: attack.ownerId,
      targetId: attack.targetId,
      x: attack.x,
      y: attack.y,
      hit: Boolean(attack.hit),
      sunkShip: attack.sunkShip || null,
      round: attack.round,
    })),
    results: round.results || [],
    outcome: round.outcome || null,
    ...(host && round.lastQuestion
      ? { lastQuestion: questionForClient(round.lastQuestion, { reveal: true }) }
      : {}),
  };
}

function playerRound(session, player) {
  const state = session.state;
  const round = state.round;
  if (!round) return null;
  const ownerId = ownerForPlayer(state, player);
  const combatant = round.combatants?.find((entry) => entry.id === ownerId) || null;
  const targetId = combatant?.targetId || null;
  const reveal = state.phase === PHASES.ROUND_OVER;
  const base = roundProjection(session, { revealShips: reveal });
  const isSpectator = player.role === ROLES.SPECTATOR;

  if (!isSpectator) {
    base.boards = base.boards.filter((board) => board.id === ownerId || board.id === targetId);
  }

  const answer = round.answers?.[player.id] || null;
  const score = base.scores.find((entry) => entry.id === ownerId) || null;
  const attacksUsed = round.attacks.filter((entry) => entry.ownerId === ownerId).length;

  base.me = {
    playerId: player.id,
    ownerId,
    role: player.role,
    spectator: isSpectator,
    teamId: player.teamId || null,
    missiles: ownerId ? Number(state.arsenal?.[ownerId]) || 0 : 0,
    attacksUsed,
    attacksLimit: state.config.maxAttacksPerTeam,
    targetId,
    targetName: base.scores.find((entry) => entry.id === targetId)?.name || null,
    answered: Boolean(answer),
    answer: answer
      ? {
          questionNumber: answer.questionNumber,
          optionIndex: answer.optionIndex,
          correct: Boolean(answer.correct),
          reward: answer.reward || 0,
          ms: answer.ms || 0,
        }
      : null,
    score,
    ownBoard: ownerId ? boardFor(state, combatant, { revealShips: true }) : null,
    targetBoard: targetId
      ? boardFor(state, round.combatants.find((entry) => entry.id === targetId), {
          revealShips: reveal,
        })
      : null,
  };

  return base;
}

/**
 * Public state is the only projection shown on the projector and to players.
 * It is built from explicit fields, never by spreading the session snapshot,
 * so token hashes and future secret state cannot leak accidentally.
 */
export function publicProjection(session) {
  const state = session.state;
  const players = state.players.filter((player) => player.role === ROLES.PLAYER);
  const spectators = state.players.filter((player) => player.role === ROLES.SPECTATOR);
  const teams = state.teams
    .map((team) => {
      const roster = rosterFor(state, team.id);
      return {
        id: team.id,
        name: team.name,
        color: team.color,
        sortOrder: team.sortOrder,
        maxPlayers: team.maxPlayers,
        playerCount: roster.length,
        ready: roster.length > 0,
        connectedCount: roster.filter((entry) => entry.connected).length,
        players: roster,
        missiles: team.missiles || 0,
        eliminated: Boolean(team.eliminated),
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    session: {
      id: state.id,
      joinCode: state.joinCode,
      name: state.name,
      mode: state.config.mode,
      phase: state.phase,
      createdAt: state.createdAt,
      startedAt: state.startedAt || null,
      endedAt: state.endedAt || null,
      expiresAt: state.expiresAt,
      config: safeConfig(state.config),
    },
    teams,
    players: players
      .map((player) => ({
        id: player.id,
        name: player.displayName,
        teamId: player.teamId || null,
        connected: Boolean(player.connected),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    counts: {
      players: players.length,
      connected: players.filter((player) => player.connected).length,
      spectators: spectators.length,
      teams: teams.length,
    },
    join: {
      code: state.joinCode,
      url: shortJoinUrlFor(state.joinBaseUrl, state.joinCode),
      qrUrl: `/api/sessions/${encodeURIComponent(state.joinCode)}/qr.svg`,
      displayUrl: state.displayBaseUrl,
    },
    round: roundProjection(session, {
      revealShips: state.phase === PHASES.ROUND_OVER,
    }),
    meta: {
      serverNow: Date.now(),
      version: state.version,
      phase: state.phase,
    },
  };
}

export function hostProjection(session) {
  const publicState = publicProjection(session);
  return {
    ...publicState,
    round: roundProjection(session, { revealShips: true, revealAnswer: true, host: true }),
    players: session.state.players
      .map((player) => ({
        id: player.id,
        name: player.displayName,
        teamId: player.teamId || null,
        role: player.role,
        connected: Boolean(player.connected),
        joinedAt: player.joinedAt,
        lastSeenAt: player.lastSeenAt || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    events: (session.state.recentEvents || []).slice(-40),
    admin: {
      canStart: session.canStart().ok,
      startReason: session.canStart().reason || null,
      joinCode: session.state.joinCode,
      version: session.state.version,
      phase: session.state.phase,
      roundNumber: session.state.round?.number || null,
    },
  };
}

export function playerProjection(session, playerId) {
  const publicState = publicProjection(session);
  const player = session.state.players.find((entry) => entry.id === playerId);
  if (!player) {
    return {
      ...publicState,
      me: null,
    };
  }
  return {
    ...publicState,
    round: playerRound(session, player),
    me: {
      id: player.id,
      name: player.displayName,
      teamId: player.teamId || null,
      role: player.role,
      connected: Boolean(player.connected),
      joinedAt: player.joinedAt,
      streak: player.streak || 0,
      stats: player.stats || {},
    },
  };
}
