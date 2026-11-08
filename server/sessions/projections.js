import { ROLES } from '../../shared/constants.js';

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
      url: state.joinBaseUrl,
      qrUrl: `/api/sessions/${encodeURIComponent(state.joinCode)}/qr.svg`,
      displayUrl: state.displayBaseUrl,
    },
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
