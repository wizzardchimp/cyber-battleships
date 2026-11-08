import { ZodError } from 'zod';

import { EVENTS } from '../../shared/events.js';
import {
  chooseTeamSchema,
  displaySubscribeSchema,
  hostLockSchema,
  hostMovePlayerSchema,
  hostRemovePlayerSchema,
  hostRenameTeamSchema,
  hostStartSchema,
  hostSubscribeSchema,
  hostUpdateConfigSchema,
  playerJoinSchema,
  playerResumeSchema,
} from '../../shared/schemas.js';
import { AppError, errorPayload } from '../errors.js';
import { hostProjection, playerProjection, publicProjection } from '../sessions/projections.js';

const roomFor = (sessionId) => `session:${sessionId}`;

function validationMessage(error) {
  const issue = error.issues?.[0];
  return issue?.message || 'Invalid request.';
}

function toastFor(event) {
  switch (event.type) {
    case 'player_joined':
      return {
        level: 'join',
        message: event.role === 'spectator'
          ? `${event.name} is watching`
          : `${event.name} joined ${event.teamName || 'the operation'}`,
      };
    case 'player_moved':
      return { level: 'move', message: `${event.name} moved to ${event.teamName}` };
    case 'team_changed':
      return { level: 'move', message: `${event.name} switched to ${event.teamName}` };
    case 'player_removed':
      return { level: 'leave', message: `${event.name} was removed` };
    case 'team_renamed':
      return { level: 'info', message: `${event.from} renamed to ${event.name}` };
    case 'lobby_lock_changed':
      return { level: 'info', message: event.locked ? 'Lobby locked' : 'Lobby unlocked' };
    case 'mission_ready':
      return { level: 'alert', message: 'All hands: mission ready' };
    case 'returned_to_lobby':
      return { level: 'info', message: 'Returned to lobby' };
    default:
      return null;
  }
}

export function attachSocketServer(io, { manager, config, auth, logger }) {
  const playerSockets = new Map(); // playerId -> Set<socket>
  const disconnectTimers = new Map(); // playerId -> timeout
  const broadcastTimers = new Map(); // sessionId -> timeout
  const wired = new WeakSet();

  function guard(socket, key, max = 30, windowMs = 10_000) {
    const now = Date.now();
    if (!socket.data.limits) socket.data.limits = new Map();
    const stamps = (socket.data.limits.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (stamps.length >= max) {
      socket.emit(EVENTS.GAME_ERROR, {
        code: 'RATE_LIMIT',
        message: 'Slow down for a moment.',
      });
      return false;
    }
    stamps.push(now);
    socket.data.limits.set(key, stamps);
    return true;
  }

  function reply(ack, payload) {
    if (typeof ack === 'function') ack(payload);
  }

  function fail(socket, ack, error) {
    let payload;
    if (error instanceof ZodError) {
      payload = { code: 'VALIDATION', message: validationMessage(error) };
    } else {
      payload = errorPayload(error);
      if (!(error instanceof AppError)) {
        logger?.error({ err: error }, 'Unhandled socket error');
      }
    }
    if (typeof ack === 'function') ack({ ok: false, error: payload });
    else socket.emit(EVENTS.GAME_ERROR, payload);
  }

  function run(socket, ack, handler) {
    Promise.resolve()
      .then(handler)
      .catch((error) => {
        logger?.warn({ err: error, socket: socket.id, event: error?.code }, 'Socket handler failed');
        fail(socket, ack, error);
      });
  }

  function sessionFromSocket(socket) {
    if (!socket.data.sessionId) throw new AppError('NO_SESSION', 'Join an operation first.');
    return manager.require(socket.data.sessionId);
  }

  function wireSession(session) {
    if (wired.has(session)) return;
    wired.add(session);
    session.on('change', () => scheduleBroadcast(session));
    session.on('event', (event) => {
      const toast = toastFor(event);
      if (toast) io.to(roomFor(session.id)).emit(EVENTS.TOAST, toast);
    });
    session.on('playerRemoved', ({ playerId, name }) => {
      const sockets = playerSockets.get(playerId);
      if (sockets) {
        for (const target of sockets) {
          target.emit(EVENTS.PLAYER_REMOVED, { reason: 'removed', name });
          target.data.playerId = null;
        }
        playerSockets.delete(playerId);
      }
      const timer = disconnectTimers.get(playerId);
      if (timer) {
        clearTimeout(timer);
        disconnectTimers.delete(playerId);
      }
    });
    session.on('closed', ({ expired }) => {
      io.to(roomFor(session.id)).emit(EVENTS.SESSION_CLOSED, {
        reason: expired ? 'expired' : 'closed',
      });
    });
  }

  function scheduleBroadcast(session) {
    if (broadcastTimers.has(session.id)) return;
    const timer = setTimeout(() => {
      broadcastTimers.delete(session.id);
      broadcast(session);
    }, 35);
    timer.unref?.();
    broadcastTimers.set(session.id, timer);
  }

  function broadcast(session) {
    const room = io.sockets.adapter.rooms.get(roomFor(session.id));
    if (!room) return;
    for (const socketId of room) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;
      if (socket.data.role === 'host') {
        socket.emit(EVENTS.STATE, hostProjection(session));
      } else if (socket.data.role === 'display') {
        socket.emit(EVENTS.STATE, publicProjection(session));
      } else if (socket.data.role === 'player' && socket.data.playerId) {
        socket.emit(EVENTS.STATE, playerProjection(session, socket.data.playerId));
      }
    }
  }

  function sendState(socket, session) {
    if (socket.data.role === 'host') {
      socket.emit(EVENTS.STATE, hostProjection(session));
    } else if (socket.data.role === 'display') {
      socket.emit(EVENTS.STATE, publicProjection(session));
    } else if (socket.data.role === 'player' && socket.data.playerId) {
      socket.emit(EVENTS.STATE, playerProjection(session, socket.data.playerId));
    }
  }

  function leaveCurrent(socket) {
    if (socket.data.sessionId) socket.leave(roomFor(socket.data.sessionId));
    socket.data.sessionId = null;
    socket.data.role = null;
    socket.data.playerId = null;
  }

  function detachPlayer(socket, { superseded = false } = {}) {
    const playerId = socket.data.playerId;
    if (!playerId) return;
    const session = socket.data.sessionId ? manager.get(socket.data.sessionId) : null;
    const set = playerSockets.get(playerId);
    if (set) {
      set.delete(socket);
      if (set.size === 0) {
        playerSockets.delete(playerId);
        if (session && !superseded) {
          const existing = disconnectTimers.get(playerId);
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            disconnectTimers.delete(playerId);
            const live = manager.get(session.id);
            if (!live) return;
            live.setConnected(playerId, false).catch((error) => {
              logger?.warn({ err: error, playerId }, 'Failed to mark player offline');
            });
          }, 8000);
          timer.unref?.();
          disconnectTimers.set(playerId, timer);
        }
      }
    }
    socket.data.playerId = null;
  }

  async function attachPlayer(socket, session, player, { token = null, resumed = false } = {}) {
    wireSession(session);

    // Drop any previous association this socket had without scheduling an
    // offline timer; it is about to become this player's live connection.
    detachPlayer(socket, { superseded: true });
    leaveCurrent(socket);

    // Supersede every other socket for this player and remove it from the
    // live set immediately. Keeping stale sockets in the set would stop the
    // disconnect timer from ever firing for the surviving connection.
    const existing = playerSockets.get(player.id);
    if (existing) {
      for (const old of [...existing]) {
        existing.delete(old);
        old.emit(EVENTS.PLAYER_SUPERSEDED, {
          message: 'This player reconnected from another device.',
        });
        old.data.role = null;
        old.data.sessionId = null;
        old.data.playerId = null;
        old.disconnect(true);
      }
      if (existing.size === 0) playerSockets.delete(player.id);
    }

    const timer = disconnectTimers.get(player.id);
    if (timer) {
      clearTimeout(timer);
      disconnectTimers.delete(player.id);
    }
    socket.data.role = 'player';
    socket.data.playerId = player.id;
    socket.data.sessionId = session.id;
    socket.join(roomFor(session.id));
    if (!playerSockets.has(player.id)) playerSockets.set(player.id, new Set());
    playerSockets.get(player.id).add(socket);

    if (!player.connected) {
      player.connected = true;
      player.lastSeenAt = new Date().toISOString();
      await session.commit();
    }

    socket.emit(EVENTS.PLAYER_OK, {
      playerId: player.id,
      sessionId: session.id,
      name: player.displayName,
      role: player.role,
      resumed,
      ...(token ? { token } : {}),
    });
    sendState(socket, session);
    scheduleBroadcast(session);
  }

  function hostOnly(socket) {
    if (!socket.data.hostAuth) {
      throw new AppError('UNAUTHORIZED', 'Facilitator login required.', 401);
    }
  }

  io.on('connection', (socket) => {
    socket.data.hostAuth = auth.authenticateSocket(socket);
    socket.data.role = null;
    socket.data.sessionId = null;
    socket.data.playerId = null;
    socket.data.limits = new Map();
    socket.emit('hello', { serverNow: Date.now() });

    socket.on(EVENTS.TIME_SYNC, (payload, ack) => {
      reply(ack, { ok: true, serverNow: Date.now() });
    });

    socket.on(EVENTS.HOST_SUBSCRIBE, (payload, ack) => {
      run(socket, ack, async () => {
        hostOnly(socket);
        if (!guard(socket, 'host')) return;
        const data = hostSubscribeSchema.parse(payload);
        const session = manager.require(data.sessionId);
        wireSession(session);
        detachPlayer(socket, { superseded: true });
        if (socket.data.sessionId && socket.data.sessionId !== session.id) {
          socket.leave(roomFor(socket.data.sessionId));
        }
        socket.data.role = 'host';
        socket.data.sessionId = session.id;
        socket.join(roomFor(session.id));
        sendState(socket, session);
        reply(ack, { ok: true, session: session.summary() });
      });
    });

    socket.on(EVENTS.HOST_UPDATE_CONFIG, (payload, ack) => {
      run(socket, ack, async () => {
        hostOnly(socket);
        if (!guard(socket, 'host')) return;
        const data = hostUpdateConfigSchema.parse(payload);
        const session = manager.require(data.sessionId);
        await session.updateConfig(data.patch);
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.HOST_RENAME_TEAM, (payload, ack) => {
      run(socket, ack, async () => {
        hostOnly(socket);
        if (!guard(socket, 'host')) return;
        const data = hostRenameTeamSchema.parse(payload);
        const session = manager.require(data.sessionId);
        await session.renameTeam(data.teamId, data.name);
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.HOST_MOVE_PLAYER, (payload, ack) => {
      run(socket, ack, async () => {
        hostOnly(socket);
        if (!guard(socket, 'host')) return;
        const data = hostMovePlayerSchema.parse(payload);
        const session = manager.require(data.sessionId);
        await session.movePlayer(data.playerId, data.teamId);
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.HOST_REMOVE_PLAYER, (payload, ack) => {
      run(socket, ack, async () => {
        hostOnly(socket);
        if (!guard(socket, 'host')) return;
        const data = hostRemovePlayerSchema.parse(payload);
        const session = manager.require(data.sessionId);
        await session.removePlayer(data.playerId);
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.HOST_LOCK_LOBBY, (payload, ack) => {
      run(socket, ack, async () => {
        hostOnly(socket);
        if (!guard(socket, 'host')) return;
        const data = hostLockSchema.parse(payload);
        const session = manager.require(data.sessionId);
        await session.lockLobby(data.locked);
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.HOST_START, (payload, ack) => {
      run(socket, ack, async () => {
        hostOnly(socket);
        if (!guard(socket, 'host')) return;
        const data = hostStartSchema.parse(payload);
        const session = manager.require(data.sessionId);
        await session.start();
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.HOST_RETURN_TO_LOBBY, (payload, ack) => {
      run(socket, ack, async () => {
        hostOnly(socket);
        if (!guard(socket, 'host')) return;
        const data = hostStartSchema.parse(payload);
        const session = manager.require(data.sessionId);
        await session.returnToLobby();
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.PLAYER_JOIN, (payload, ack) => {
      run(socket, ack, async () => {
        if (!guard(socket, 'join', 12, 10_000)) return;
        const data = playerJoinSchema.parse(payload);
        const session = manager.requireByCode(data.code);
        wireSession(session);
        const { player, token } = session.join({
          name: data.name,
          teamId: data.teamId,
          asSpectator: data.asSpectator,
        });
        await session.commit();
        await attachPlayer(socket, session, player, { token, resumed: false });
        reply(ack, {
          ok: true,
          playerId: player.id,
          sessionId: session.id,
          token,
          session: session.summary(),
        });
      });
    });

    socket.on(EVENTS.PLAYER_RESUME, (payload, ack) => {
      run(socket, ack, async () => {
        if (!guard(socket, 'resume', 20, 10_000)) return;
        const data = playerResumeSchema.parse(payload);
        const session = manager.requireByCode(data.code);
        wireSession(session);
        const player = session.resume(data.token);
        if (!player) {
          reply(ack, {
            ok: false,
            error: { code: 'RESUME_FAILED', message: 'That player session is no longer valid.' },
          });
          return;
        }
        await attachPlayer(socket, session, player, { resumed: true });
        reply(ack, {
          ok: true,
          playerId: player.id,
          sessionId: session.id,
          name: player.displayName,
          role: player.role,
          resumed: true,
          session: session.summary(),
        });
      });
    });

    socket.on(EVENTS.PLAYER_CHOOSE_TEAM, (payload, ack) => {
      run(socket, ack, async () => {
        if (!guard(socket, 'team')) return;
        const data = chooseTeamSchema.parse(payload);
        const session = sessionFromSocket(socket);
        if (socket.data.role !== 'player') {
          throw new AppError('UNAUTHORIZED', 'Players only.');
        }
        await session.chooseTeam(socket.data.playerId, data.teamId);
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.DISPLAY_SUBSCRIBE, (payload, ack) => {
      run(socket, ack, async () => {
        if (!guard(socket, 'display')) return;
        const data = displaySubscribeSchema.parse(payload);
        const session = manager.requireByCode(data.code);
        wireSession(session);
        detachPlayer(socket, { superseded: true });
        if (socket.data.sessionId && socket.data.sessionId !== session.id) {
          socket.leave(roomFor(socket.data.sessionId));
        }
        socket.data.role = 'display';
        socket.data.sessionId = session.id;
        socket.join(roomFor(session.id));
        sendState(socket, session);
        reply(ack, { ok: true, session: session.summary() });
      });
    });

    socket.on('disconnect', () => {
      detachPlayer(socket);
    });
  });

  manager.on('closed', ({ sessionId }) => {
    const timer = broadcastTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    broadcastTimers.delete(sessionId);
  });

  return {
    broadcast,
    roomFor,
  };
}
