/**
 * Socket.IO wiring.
 *
 * Every mutation goes through the Game instance, so the socket layer is mostly
 * authentication, validation of wire formats, rate limiting and fan-out of
 * role-scoped state.
 */

import crypto from 'node:crypto';
import { HOST_PIN } from '../config.js';
import { joinUrlFor } from '../network.js';
import { GameError } from '../game/constants.js';
import { project } from '../game/projection.js';

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function attachSockets(io, { game, store, hostPin = HOST_PIN }) {
  const playerSockets = new Map(); // playerId -> Set<socket>
  let broadcastTimer = null;

  const scheduleBroadcast = () => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      broadcastAll();
    }, 40);
  };

  game.on('change', scheduleBroadcast);

  game.on('fx', (fx) => {
    io.emit('fx', fx);
  });

  game.on('toast', (toast) => {
    io.emit('toast', toast);
  });

  game.on('kick', ({ playerId, reason }) => {
    const sockets = playerSockets.get(playerId);
    if (!sockets) return;
    for (const socket of sockets) {
      socket.data.playerId = null;
      socket.emit('session:ended', { reason });
    }
    playerSockets.delete(playerId);
  });

  function withMeta(state) {
    return { ...state, meta: { joinUrl: joinUrlFor(game.code), now: Date.now() } };
  }

  function sendState(socket) {
    const role = socket.data.role;
    if (role === 'host') {
      socket.emit('state', withMeta(project(game, 'host')));
    } else if (role === 'display') {
      socket.emit('state', withMeta(project(game, 'display')));
    } else {
      socket.emit('state', withMeta(project(game, 'player', socket.data.playerId || null)));
    }
  }

  function broadcastAll() {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.role === 'host') {
        socket.emit('state', withMeta(project(game, 'host')));
      } else if (socket.data.role === 'display') {
        socket.emit('state', withMeta(project(game, 'display')));
      } else if (socket.data.role === 'player') {
        const playerId = socket.data.playerId;
        if (playerId && game.players.has(playerId)) {
          socket.emit('state', withMeta(project(game, 'player', playerId)));
        } else {
          socket.emit('state', withMeta(project(game, 'player', null)));
        }
      } else {
        socket.emit('state', withMeta(project(game, 'player', null)));
      }
    }
  }

  const buckets = new Map();
  function allow(socket, key, max, windowMs) {
    const id = socket.id;
    const now = Date.now();
    let entry = buckets.get(id);
    if (!entry) {
      entry = new Map();
      buckets.set(id, entry);
    }
    const stamps = (entry.get(key) || []).filter((stamp) => now - stamp < windowMs);
    if (stamps.length >= max) {
      entry.set(key, stamps);
      return false;
    }
    stamps.push(now);
    entry.set(key, stamps);
    return true;
  }

  function guard(socket, key, max = 20, windowMs = 10000) {
    if (!allow(socket, key, max, windowMs)) {
      socket.emit('game:error', { code: 'RATE_LIMIT', message: 'Slow down for a moment.' });
      return false;
    }
    return true;
  }

  function run(socket, handler) {
    try {
      handler();
    } catch (error) {
      if (error instanceof GameError) {
        socket.emit('game:error', { code: error.code, message: error.message });
      } else {
        console.error('[socket] Unhandled error:', error);
        socket.emit('game:error', { code: 'SERVER_ERROR', message: 'Something went wrong on the server.' });
      }
    }
  }

  function hostOnly(socket) {
    if (socket.data.role !== 'host') {
      throw new GameError('UNAUTHORIZED', 'Presenter authentication required.');
    }
  }

  function hostAction(socket, handler) {
    run(socket, () => {
      hostOnly(socket);
      handler();
    });
  }

  function attachPlayer(socket, player, resumed) {
    const existing = playerSockets.get(player.id);
    if (existing) {
      for (const old of existing) {
        if (old.id === socket.id) continue;
        old.data.playerId = null;
        old.emit('session:superseded', { message: 'This player joined from another device.' });
        old.disconnect(true);
      }
    }

    socket.data.role = 'player';
    socket.data.playerId = player.id;
    if (!playerSockets.has(player.id)) playerSockets.set(player.id, new Set());
    playerSockets.get(player.id).add(socket);

    player.connected = true;
    socket.emit('player:ok', {
      token: player.token,
      playerId: player.id,
      name: player.name,
      resumed,
    });
    sendState(socket);
    scheduleBroadcast();
  }

  io.on('connection', (socket) => {
    socket.data.role = 'unknown';
    socket.data.playerId = null;
    socket.emit('hello', { serverNow: Date.now() });

    socket.on('display:hello', () => {
      socket.data.role = 'display';
      sendState(socket);
    });

    socket.on('host:auth', (payload = {}) => {
      if (!allow(socket, 'host-auth', 8, 60000)) {
        socket.emit('host:denied', { message: 'Too many attempts. Wait a minute and try again.' });
        return;
      }
      const token = payload.token ? String(payload.token) : '';
      let authenticated = Boolean(token && game.hostTokens.has(token));
      if (!authenticated && payload.pin !== undefined) {
        authenticated = constantTimeEqual(String(payload.pin), hostPin);
      }
      if (!authenticated) {
        socket.emit('host:denied', { message: 'Incorrect presenter PIN.' });
        return;
      }

      let issued = token && game.hostTokens.has(token) ? token : crypto.randomBytes(24).toString('hex');
      game.hostTokens.add(issued);
      if (game.hostTokens.size > 12) {
        const oldest = game.hostTokens.values().next().value;
        if (oldest !== issued) game.hostTokens.delete(oldest);
      }
      socket.data.role = 'host';
      socket.emit('host:ok', { token: issued });
      sendState(socket);
    });

    socket.on('player:hello', () => {
      sendState(socket);
    });

    socket.on('player:join', (payload = {}) => {
      if (!guard(socket, 'join', 8, 30000)) return;
      run(socket, () => {
        if (socket.data.playerId) throw new GameError('ALREADY_JOINED', 'You have already joined this game.');
        const player = game.join({
          code: payload.code,
          name: payload.name,
          teamId: payload.teamId || null,
        });
        attachPlayer(socket, player, false);
      });
    });

    socket.on('player:resume', (payload = {}) => {
      if (!guard(socket, 'resume', 10, 30000)) return;
      run(socket, () => {
        const player = game.resumeByToken(String(payload.token || ''));
        if (!player) {
          socket.emit('player:gone');
          return;
        }
        attachPlayer(socket, player, true);
      });
    });

    socket.on('player:answer', (payload = {}) => {
      if (!guard(socket, 'answer', 12, 10000)) return;
      run(socket, () => {
        if (!socket.data.playerId) throw new GameError('NOT_JOINED', 'Join the game first.');
        game.submitAnswer(socket.data.playerId, payload.questionId, payload.optionIndex);
        sendState(socket);
      });
    });

    socket.on('player:fire', (payload = {}) => {
      if (!guard(socket, 'fire', 12, 10000)) return;
      run(socket, () => {
        if (!socket.data.playerId) throw new GameError('NOT_JOINED', 'Join the game first.');
        game.fire(
          socket.data.playerId,
          payload.targetGridId,
          payload.col,
          payload.row,
          payload.nonce ? String(payload.nonce).slice(0, 60) : null,
        );
        sendState(socket);
      });
    });

    socket.on('player:leave', () => {
      run(socket, () => {
        const playerId = socket.data.playerId;
        if (!playerId) return;
        game.removePlayer(playerId, 'left');
        const set = playerSockets.get(playerId);
        if (set) set.delete(socket);
        if (!set || set.size === 0) playerSockets.delete(playerId);
        socket.data.playerId = null;
        sendState(socket);
      });
    });

    socket.on('player:state', () => sendState(socket));

    // ------------------------------------------------------------- host actions

    socket.on('host:settings', (payload = {}) => hostAction(socket, () => {
      game.updateSettings(payload.patch || {});
    }));

    socket.on('host:start', () => hostAction(socket, () => game.start()));
    socket.on('host:pause', (payload = {}) => hostAction(socket, () => game.setPaused(Boolean(payload.paused))));
    socket.on('host:reveal', () => hostAction(socket, () => game.revealQuestion()));
    socket.on('host:battle', () => hostAction(socket, () => game.enterBattle()));
    socket.on('host:next', () => hostAction(socket, () => game.nextQuestion()));
    socket.on('host:end', () => hostAction(socket, () => game.endGame('host-ended')));
    socket.on('host:restart', () => hostAction(socket, () => game.restart()));
    socket.on('host:newGame', () => hostAction(socket, () => game.newGame()));

    socket.on('host:randomiseShips', (payload = {}) => hostAction(socket, () => {
      const gridId = payload.gridId ? String(payload.gridId) : null;
      if (!gridId) {
        game.randomiseShips();
      } else {
        if (!game.grids.has(gridId)) throw new GameError('INVALID_GRID', 'Grid not found.');
        game.randomiseShips(gridId);
      }
    }));

    socket.on('host:setShips', (payload = {}, reply = () => {}) => hostAction(socket, () => {
      const gridId = String(payload.gridId || '');
      if (!game.grids.has(gridId)) throw new GameError('INVALID_GRID', 'Grid not found.');
      game.setShips(gridId, payload.ships);
      if (typeof reply === 'function') reply({ ok: true, gridId });
    }));

    socket.on('host:teamName', (payload = {}) => hostAction(socket, () => {
      game.setTeamName(String(payload.teamId || ''), payload.name);
    }));

    socket.on('host:addTeam', (payload = {}) => hostAction(socket, () => {
      game.addTeam(payload.name);
    }));

    socket.on('host:removeTeam', (payload = {}) => hostAction(socket, () => {
      game.removeTeam(String(payload.teamId || ''));
    }));

    socket.on('host:movePlayer', (payload = {}) => hostAction(socket, () => {
      game.movePlayer(String(payload.playerId || ''), String(payload.teamId || ''));
    }));

    socket.on('host:removePlayer', (payload = {}) => hostAction(socket, () => {
      game.removePlayer(String(payload.playerId || ''), 'removed-by-host');
    }));

    socket.on('host:missiles', (payload = {}) => hostAction(socket, () => {
      game.hostAwardMissiles(String(payload.teamId || ''), Number.parseInt(payload.delta, 10) || 0);
    }));

    socket.on('host:questionSave', (payload = {}) => hostAction(socket, () => {
      store.upsert(payload.question || {});
      scheduleBroadcast();
    }));

    socket.on('host:questionDelete', (payload = {}) => hostAction(socket, () => {
      store.remove(String(payload.id || ''));
      scheduleBroadcast();
    }));

    socket.on('host:questionReplace', (payload = {}) => hostAction(socket, () => {
      store.replaceAll(payload.questions);
      scheduleBroadcast();
    }));

    socket.on('host:state', () => sendState(socket));

    socket.on('disconnect', () => {
      buckets.delete(socket.id);
      const playerId = socket.data.playerId;
      if (playerId) {
        const set = playerSockets.get(playerId);
        if (set) {
          set.delete(socket);
          if (set.size === 0) {
            playerSockets.delete(playerId);
            game.setConnected(playerId, false);
          }
        }
      }
    });
  });

  return {
    broadcastAll,
    stop() {
      if (broadcastTimer) clearTimeout(broadcastTimer);
    },
  };
}
