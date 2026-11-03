/**
 * Role-scoped projections.
 *
 * The same game state is rendered three different ways:
 *   display - the projector. Never sees unsunk ship positions.
 *   host    - the presenter. Sees everything, including the answer key.
 *   player  - one phone. Sees its own fleet, the answer key only on reveal,
 *             and opponents only as shots already fired.
 *
 * Keeping projection in one place is what stops ship and answer data leaking
 * into the wrong browser.
 */

import { PHASES } from './constants.js';

function accuracy(stats) {
  return stats.missilesFired ? Math.round((stats.hits / stats.missilesFired) * 100) : 0;
}

function teamSummary(game, team) {
  return {
    id: team.id,
    name: team.name,
    color: team.color,
    score: team.score,
    missiles: team.missiles,
    eliminated: team.eliminated,
    gridId: team.gridId,
    playerCount: team.players.length,
    members: team.players
      .map((id) => game.players.get(id))
      .filter(Boolean)
      .map((player) => ({ id: player.id, name: player.name, connected: player.connected })),
    stats: { ...team.stats },
    accuracy: accuracy(team.stats),
  };
}

function startIssues(game) {
  const issues = [];
  if (game.phase !== PHASES.LOBBY) issues.push('The game has already started.');
  if (game.store.count === 0) issues.push('Add at least one question.');
  if (game.isOneGrid) {
    if (game.players.size === 0) issues.push('At least one player must join.');
  } else {
    if (game.teams.length < 2) issues.push('At least two teams are required.');
    for (const team of game.teams) {
      if (team.players.length === 0) issues.push(`${team.name} has no players.`);
    }
  }
  return issues;
}

function roundFor(game, role) {
  if (!game.round) return null;
  const revealed = [PHASES.REVEAL, PHASES.BATTLE, PHASES.ENDED].includes(game.phase) || Boolean(game.round.revealedAt);
  const questions = game.round.questions.map((rq) => {
    const base = {
      id: rq.questionId,
      number: rq.number,
      topic: rq.question.topic,
      difficulty: rq.question.difficulty ?? 1,
      question: rq.question.question,
      options: [...rq.question.options],
      endsAt: game.phase === PHASES.QUESTION ? game.round.endsAt : null,
      revealed,
      firstCorrectTeamId: rq.firstCorrectTeamId,
    };
    if (revealed || role === 'host') {
      base.correctIndex = rq.question.correctIndex;
      base.explanation = rq.question.explanation;
    }
    if (revealed) {
      base.awards = [...rq.awards];
      base.revealedAt = game.round.revealedAt;
    }
    return base;
  });
  return {
    number: game.round.number,
    startedAt: game.round.startedAt,
    endsAt: game.round.endsAt,
    revealedAt: game.round.revealedAt,
    revealed,
    questions,
  };
}

function gridProjection(game, grid, role, viewerTeamId) {
  const ownerTeam = grid.ownerTeamId ? game.getTeam(grid.ownerTeamId) : null;
  const isOwn = Boolean(viewerTeamId && grid.ownerTeamId === viewerTeamId);
  const revealShips = role === 'host'
    || (role === 'display' && game.settings.revealShips)
    || (role === 'player' && isOwn);

  return {
    id: grid.id,
    ownerTeamId: grid.ownerTeamId,
    label: ownerTeam ? ownerTeam.name : grid.label,
    color: ownerTeam ? ownerTeam.color : '#25e6ff',
    cols: grid.cols,
    rows: grid.rows,
    cells: grid.cellMatrix({ revealShips }),
    health: grid.health,
    destroyed: grid.destroyed,
    eliminated: ownerTeam ? ownerTeam.eliminated : false,
    ships: grid.ships.map((ship) => ({
      key: ship.key,
      name: ship.name,
      length: ship.length,
      hits: ship.hits.length,
      remaining: ship.length - ship.hits.length,
      sunk: grid.isShipSunk(ship),
      ...(role === 'host' ? { cells: ship.cells.map((cell) => ({ ...cell })) } : {}),
    })),
    shots: [...grid.shots.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, 60)
      .map((shot) => ({
        coord: shot.coord,
        col: shot.col,
        row: shot.row,
        hit: shot.hit,
        sunk: Boolean(shot.sunkShipKey),
        sunkShipName: shot.sunkShipName,
        byTeamId: shot.byTeamId,
        at: shot.at,
      })),
  };
}

function answerStats(game, role, viewerPlayer) {
  const activePlayers = [...game.players.values()].filter((player) => {
    const team = game.getTeam(player.teamId);
    return team && !team.eliminated;
  });
  const roundQuestionIds = new Set((game.round?.questions || []).map((q) => q.questionId));

  const answered = activePlayers.filter((player) => {
    const answers = player.round || {};
    return Object.keys(answers).some((qid) => roundQuestionIds.has(qid) && answers[qid]?.attempts > 0);
  });

  const payload = {
    total: activePlayers.length,
    answered: answered.length,
    names: answered.map((player) => player.name),
  };

  if (role === 'host') {
    payload.details = activePlayers.map((player) => {
      const team = game.getTeam(player.teamId);
      const answers = player.round || {};
      const attempts = Object.values(answers)
        .filter((a) => roundQuestionIds.has(a.questionId))
        .reduce((sum, a) => sum + (a.attempts || 0), 0);
      const correctCount = Object.values(answers)
        .filter((a) => roundQuestionIds.has(a.questionId) && a.correct).length;
      const locked = Object.values(answers)
        .some((a) => roundQuestionIds.has(a.questionId) && a.locked);
      return {
        playerId: player.id,
        name: player.name,
        teamId: player.teamId,
        teamName: team?.name ?? '',
        connected: player.connected,
        attempts,
        correctCount,
        locked,
        answers: Object.fromEntries(
          Object.entries(answers)
            .filter(([qid]) => roundQuestionIds.has(qid))
            .map(([qid, a]) => [qid, {
              attempts: a.attempts ?? 0,
              answerIndex: a.answerIndex ?? null,
              correct: a.correct ?? null,
              locked: a.locked ?? false,
              awarded: a.awarded ?? false,
            }]),
        ),
      };
    });
  }

  if (role === 'player' && viewerPlayer) {
    const answers = viewerPlayer.round || {};
    payload.mine = {};
    for (const qid of roundQuestionIds) {
      payload.mine[qid] = answers[qid] ? { ...answers[qid] } : null;
    }
  }

  return payload;
}

function meProjection(game, player) {
  if (!player) return null;
  const team = game.getTeam(player.teamId);
  if (!team) return null;
  const targets = [...game.grids.values()]
    .filter((grid) => (game.isOneGrid ? grid.id === 'target' : grid.ownerTeamId !== team.id))
    .map((grid) => grid.id);
  const canAct = !game.paused && !game.ending;
  const canAnswer = canAct && game.phase === PHASES.QUESTION && !team.eliminated;
  const canFire = canAct
    && game.phase === PHASES.BATTLE
    && !team.eliminated
    && team.missiles > 0;

  return {
    id: player.id,
    name: player.name,
    teamId: team.id,
    teamName: team.name,
    teamColor: team.color,
    score: team.score,
    missiles: team.missiles,
    eliminated: team.eliminated,
    connected: player.connected,
    ownGridId: team.gridId,
    targets,
    canAnswer,
    canFire,
    attemptsLeft: game.settings.maxAttempts,
    roundAnswers: player.round ? { ...player.round } : {},
    totals: { ...player.totals },
    teammates: team.players
      .map((id) => game.players.get(id))
      .filter(Boolean)
      .map((entry) => ({ id: entry.id, name: entry.name, connected: entry.connected })),
  };
}

function finalProjection(game) {
  if (!game.final) return null;
  return {
    ...game.final,
    ranking: game.final.ranking.map((row) => ({ ...row, stats: { ...row.stats } })),
  };
}

/**
 * @param {import('./game.js').Game} game
 * @param {'display'|'host'|'player'} role
 * @param {string|null} playerId
 */
export function project(game, role, playerId = null) {
  const viewerPlayer = playerId ? game.players.get(playerId) : null;
  const viewerTeamId = viewerPlayer?.teamId ?? null;

  const base = {
    role,
    revision: game.revision,
    serverNow: Date.now(),
    code: game.code,
    phase: game.phase,
    paused: game.paused,
    ending: game.ending,
    phaseEndsAt: game.phaseEndsAt,
    settings: {
      gridCount: game.settings.gridCount,
      mode: game.settings.mode,
      awardMode: game.settings.awardMode,
      questionMode: game.settings.questionMode,
      maxAttempts: game.settings.maxAttempts,
      missileCap: game.settings.missileCap,
      missilesRetained: game.settings.missilesRetained,
      questionSeconds: game.settings.questionSeconds,
      revealSeconds: game.settings.revealSeconds,
      autoIntervalSeconds: game.settings.autoIntervalSeconds,
      allowLateJoin: game.settings.allowLateJoin,
      soundOn: game.settings.soundOn,
      revealShips: game.settings.revealShips,
      maxPerTeam: game.settings.maxPerTeam,
      maxPlayers: game.settings.maxPlayers,
      teamNames: [...game.settings.teamNames],
    },
    teams: game.teams.map((team) => teamSummary(game, team)),
    grids: [...game.grids.values()].map((grid) => gridProjection(game, grid, role, viewerTeamId)),
    round: roundFor(game, role),
    question: roundFor(game, role)?.questions?.[0] ?? null,
    answerStats: game.round && [PHASES.QUESTION, PHASES.REVEAL].includes(game.phase)
      ? answerStats(game, role, viewerPlayer)
      : { total: 0, answered: 0, names: [] },
    shots: game.shots.slice(0, 14).map((shot) => ({ ...shot })),
    final: finalProjection(game),
    askedCount: game.askedCount,
    playerCount: game.players.size,
    isOneGrid: game.isOneGrid,
    winnerTeamId: game.winnerTeamId,
  };

  if (role === 'host') {
    base.canStart = startIssues(game).length === 0;
    base.startIssues = startIssues(game);
    base.questions = game.store.list();
    base.hostTokens = undefined;
  }

  if (role === 'player') {
    base.me = meProjection(game, viewerPlayer);
    base.playerConnected = Boolean(viewerPlayer);
    base.playerName = viewerPlayer?.name ?? null;
  }

  return base;
}
