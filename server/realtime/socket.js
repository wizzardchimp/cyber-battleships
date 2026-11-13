import { ZodError } from 'zod';

import { LIMITS } from '../../shared/constants.js';
import { EVENTS } from '../../shared/events.js';
import {
  chooseTeamSchema,
  displayCreateSchema,
  displayRemoveSchema,
  displaySettingsSchema,
  displaySubscribeSchema,
  playerAnswerSchema,
  passCaptainSchema,
  playerAttackSchema,
  playerJoinSchema,
  playerResumeSchema,
} from '../../shared/schemas.js';
import { AppError, errorPayload } from '../errors.js';
import { playerProjection, publicProjection } from '../sessions/projections.js';
import { baseUrlFromHeaders, safeEqual } from '../util/security.js';

const roomFor = (sessionId) => `session:${sessionId}`;

function validationMessage(error) {
  return error.issues?.[0]?.message || 'Invalid request.';
}

function toastFor(event) {
  switch (event.type) {
    case 'player_joined':
      return { level: 'join', message: `${event.name} joined ${event.teamName || 'the game'}` };
    case 'team_changed':
      return { level: 'move', message: `${event.name} moved to ${event.teamName}` };
    case 'player_removed':
      return { level: 'leave', message: `${event.name} was removed` };
    case 'players_reset':
      return { level: 'leave', message: `All ${event.count} player${event.count === 1 ? '' : 's'} removed` };
    case 'captain_rotated':
    case 'captain_passed':
      return { level: 'move', message: `${event.teamName}: ${event.name} takes the controls` };
    case 'ship_sunk':
      return {
        level: 'alert',
        message: `${event.teamName} sank ${event.targetName}'s ${event.shipName}`,
      };
    default:
      return null;
  }
}

export function attachSocketServer(io, { manager, config, logger }) {
  const playerSockets = new Map(); // playerId -> Set<socket>
  const disconnectTimers = new Map(); // playerId -> timeout
  const broadcastTimers = new Map(); // sessionId -> timeout
  const wired = new WeakSet();

  // Wrong-PIN lockout: five misses in a minute locks that address for a minute.
  const pinMisses = new Map();
  function pinLocked(ip) {
    const entry = pinMisses.get(ip);
    return Boolean(entry && entry.count >= 5 && Date.now() < entry.until);
  }
  function pinFailed(ip) {
    const now = Date.now();
    const entry = pinMisses.get(ip);
    if (!entry || now > entry.until) pinMisses.set(ip, { count: 1, until: now + 60_000 });
    else entry.count += 1;
  }
  function pinOk(ip) {
    pinMisses.delete(ip);
  }

  function guard(socket, key, max = 30, windowMs = 10_000) {
    const now = Date.now();
    if (!socket.data.limits) socket.data.limits = new Map();
    const stamps = (socket.data.limits.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (stamps.length >= max) {
      socket.emit(EVENTS.GAME_ERROR, { code: 'RATE_LIMIT', message: 'Slow down for a moment.' });
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
      if (!(error instanceof AppError)) logger?.error({ err: error }, 'Unhandled socket error');
    }
    if (typeof ack === 'function') ack({ ok: false, error: payload });
    else socket.emit(EVENTS.GAME_ERROR, payload);
  }

  function run(socket, ack, handler) {
    Promise.resolve()
      .then(handler)
      .catch((error) => {
        logger?.debug({ err: error, socket: socket.id }, 'Socket handler failed');
        fail(socket, ack, error);
      });
  }

  function sessionFromSocket(socket) {
    if (!socket.data.sessionId) throw new AppError('NO_SESSION', 'Join a game first.');
    return manager.require(socket.data.sessionId);
  }

  function controlOnly(socket) {
    if (socket.data.role !== 'display' || !socket.data.control) {
      throw new AppError('UNAUTHORIZED', 'Only the game screen can do that.', 401);
    }
  }

  function wireSession(session) {
    if (wired.has(session)) return;
    wired.add(session);
    session.on('change', () => scheduleBroadcast(session));
    session.on('event', (event) => {
      const toast = toastFor(event);
      if (toast) io.to(roomFor(session.id)).emit(EVENTS.TOAST, toast);
    });
    session.on('playerRemoved', ({ playerId, name, reason = 'removed' }) => {
      const sockets = playerSockets.get(playerId);
      if (sockets) {
        for (const target of sockets) {
          target.emit(EVENTS.PLAYER_REMOVED, { reason, name });
          target.data.playerId = null;
          target.data.role = null;
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
      const room = io.sockets.adapter.rooms.get(roomFor(session.id));
      for (const socketId of [...(room || [])]) {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        socket.leave(roomFor(session.id));
        socket.data.role = null;
        socket.data.control = false;
        socket.data.sessionId = null;
        socket.data.playerId = null;
      }
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

  function projectionFor(socket, session) {
    if (socket.data.role === 'display') {
      return publicProjection(session, { control: Boolean(socket.data.control) });
    }
    if (socket.data.role === 'player' && socket.data.playerId) {
      return playerProjection(session, socket.data.playerId);
    }
    return null;
  }

  function broadcast(session) {
    const room = io.sockets.adapter.rooms.get(roomFor(session.id));
    if (!room) return;
    for (const socketId of room) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) continue;
      const projection = projectionFor(socket, session);
      if (projection) socket.emit(EVENTS.STATE, projection);
    }
  }

  function sendState(socket, session) {
    const projection = projectionFor(socket, session);
    if (projection) socket.emit(EVENTS.STATE, projection);
  }

  function leaveCurrent(socket) {
    if (socket.data.sessionId) socket.leave(roomFor(socket.data.sessionId));
    socket.data.sessionId = null;
    socket.data.role = null;
    socket.data.control = false;
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
          }, LIMITS.reconnectGraceMs);
          timer.unref?.();
          disconnectTimers.set(playerId, timer);
        }
      }
    }
    socket.data.playerId = null;
  }

  async function attachPlayer(socket, session, player, { token = null, resumed = false } = {}) {
    wireSession(session);
    detachPlayer(socket, { superseded: true });
    leaveCurrent(socket);

    // Supersede every other socket for this player straight away so the
    // disconnect timer still fires for the surviving connection.
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
    socket.data.control = false;
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
      resumed,
      ...(token ? { token } : {}),
    });
    sendState(socket, session);
    scheduleBroadcast(session);
  }

  function attachDisplay(socket, session, { control }) {
    wireSession(session);
    detachPlayer(socket, { superseded: true });
    if (socket.data.sessionId && socket.data.sessionId !== session.id) {
      socket.leave(roomFor(socket.data.sessionId));
    }
    socket.data.role = 'display';
    socket.data.control = Boolean(control);
    socket.data.sessionId = session.id;
    socket.join(roomFor(session.id));
    sendState(socket, session);
  }

  io.on('connection', (socket) => {
    socket.data.role = null;
    socket.data.control = false;
    socket.data.sessionId = null;
    socket.data.playerId = null;
    socket.data.limits = new Map();
    socket.emit('hello', { serverNow: Date.now() });

    socket.on(EVENTS.TIME_SYNC, (payload, ack) => {
      reply(ack, { ok: true, serverNow: Date.now() });
    });

    // ------------------------------------------------------------ game screen

    socket.on(EVENTS.DISPLAY_SUBSCRIBE, (payload, ack) => {
      run(socket, ack, async () => {
        if (!guard(socket, 'display')) return;
        const data = displaySubscribeSchema.parse(payload ?? {});
        const session = manager.current();
        if (!session) {
          leaveCurrent(socket);
          reply(ack, { ok: true, game: null, control: false, pinRequired: Boolean(config.facilitatorPin) });
          return;
        }
        const control = manager.keyMatches(session, data.key);
        attachDisplay(socket, session, { control });
        reply(ack, {
          ok: true,
          game: session.summary(),
          control,
          pinRequired: Boolean(config.facilitatorPin),
        });
      });
    });

    socket.on(EVENTS.DISPLAY_CREATE, (payload, ack) => {
      run(socket, ack, async () => {
        if (!guard(socket, 'display-create', 6, 10_000)) return;
        const data = displayCreateSchema.parse(payload ?? {});
        const existing = manager.current();
        const holdsKey = Boolean(existing) && manager.keyMatches(existing, data.key);
        // The facilitator PIN guards starting a game and replacing a running one.
        // The screen that already holds the control key does not need it.
        if (config.facilitatorPin && !holdsKey) {
          const ip = socket.handshake.address || 'unknown';
          if (pinLocked(ip)) {
            throw new AppError('PIN_LOCKED', 'Too many wrong PINs. Wait a minute and try again.', 429);
          }
          if (!data.pin) {
            throw new AppError('PIN_REQUIRED', 'Enter the facilitator PIN to start a game.', 401);
          }
          if (!safeEqual(data.pin.toLowerCase(), config.facilitatorPin.toLowerCase())) {
            pinFailed(ip);
            throw new AppError('WRONG_PIN', 'That PIN is not right.', 401);
          }
          pinOk(ip);
        }
        if (existing && !holdsKey && data.force !== true) {
          throw new AppError(
            'GAME_EXISTS',
            'A game is already running. Use the game screen that started it.',
            409,
          );
        }
        const baseUrl = baseUrlFromHeaders(socket.handshake.headers, config);
        const { session, controlKey } = await manager.createGame({ baseUrl });
        attachDisplay(socket, session, { control: true });
        reply(ack, { ok: true, key: controlKey, game: session.summary(), control: true });
      });
    });

    socket.on(EVENTS.DISPLAY_ADVANCE, (payload, ack) => {
      run(socket, ack, async () => {
        controlOnly(socket);
        if (!guard(socket, 'control', 20)) return;
        await sessionFromSocket(socket).advance();
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.DISPLAY_RESUME, (payload, ack) => {
      run(socket, ack, async () => {
        controlOnly(socket);
        if (!guard(socket, 'control', 20)) return;
        await sessionFromSocket(socket).resumeFight();
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.DISPLAY_FINISH, (payload, ack) => {
      run(socket, ack, async () => {
        controlOnly(socket);
        if (!guard(socket, 'control', 20)) return;
        await sessionFromSocket(socket).finish();
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.DISPLAY_LOBBY, (payload, ack) => {
      run(socket, ack, async () => {
        controlOnly(socket);
        if (!guard(socket, 'control', 20)) return;
        await sessionFromSocket(socket).returnToLobby();
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.DISPLAY_SETTINGS, (payload, ack) => {
      run(socket, ack, async () => {
        controlOnly(socket);
        if (!guard(socket, 'control', 30)) return;
        const data = displaySettingsSchema.parse(payload ?? {});
        await sessionFromSocket(socket).updateConfig(data.patch);
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.DISPLAY_REMOVE, (payload, ack) => {
      run(socket, ack, async () => {
        controlOnly(socket);
        if (!guard(socket, 'control', 30)) return;
        const data = displayRemoveSchema.parse(payload ?? {});
        await sessionFromSocket(socket).removePlayer(data.playerId);
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.DISPLAY_RESET_PLAYERS, (payload, ack) => {
      run(socket, ack, async () => {
        controlOnly(socket);
        if (!guard(socket, 'control', 10)) return;
        const removed = await sessionFromSocket(socket).resetPlayers();
        reply(ack, { ok: true, removed });
      });
    });

    // ---------------------------------------------------------------- players

    socket.on(EVENTS.PLAYER_JOIN, (payload, ack) => {
      run(socket, ack, async () => {
        if (!guard(socket, 'join', 12, 10_000)) return;
        const data = playerJoinSchema.parse(payload);
        const session = manager.requireByCode(data.code);
        wireSession(session);
        const { player, token } = session.join({ name: data.name, teamId: data.teamId });
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
        if (socket.data.role !== 'player') throw new AppError('UNAUTHORIZED', 'Players only.');
        await session.chooseTeam(socket.data.playerId, data.teamId);
        reply(ack, { ok: true });
      });
    });

    socket.on(EVENTS.PLAYER_ANSWER, (payload, ack) => {
      run(socket, ack, async () => {
        if (!guard(socket, 'answer', 40, 10_000)) return;
        if (socket.data.role !== 'player' || !socket.data.playerId) {
          throw new AppError('UNAUTHORIZED', 'Join the game to answer.', 401);
        }
        const data = playerAnswerSchema.parse(payload);
        const result = await sessionFromSocket(socket).answer(
          socket.data.playerId,
          data.questionNumber,
          data.optionIndex,
        );
        reply(ack, { ok: true, ...result });
      });
    });

    socket.on(EVENTS.PLAYER_ATTACK, (payload, ack) => {
      run(socket, ack, async () => {
        if (!guard(socket, 'attack', 60, 10_000)) return;
        if (socket.data.role !== 'player' || !socket.data.playerId) {
          throw new AppError('UNAUTHORIZED', 'Join the game to fire.', 401);
        }
        const data = playerAttackSchema.parse(payload);
        const result = await sessionFromSocket(socket).attack(socket.data.playerId, data.x, data.y, data.targetId);
        reply(ack, { ok: true, ...result });
      });
    });

    socket.on(EVENTS.PLAYER_PASS_CAPTAIN, (payload, ack) => {
      run(socket, ack, async () => {
        if (!guard(socket, 'passCaptain', 10, 10_000)) return;
        if (socket.data.role !== 'player' || !socket.data.playerId) {
          throw new AppError('UNAUTHORIZED', 'Join the game to pass control.', 401);
        }
        const data = passCaptainSchema.parse(payload);
        const result = await sessionFromSocket(socket).passCaptain(socket.data.playerId, data.playerId);
        reply(ack, { ok: true, ...result });
      });
    });

    socket.on('disconnect', () => {
      detachPlayer(socket);
    });
  });

  return { broadcast, roomFor };
}
