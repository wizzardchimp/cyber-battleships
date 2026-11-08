import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import pino from 'pino';
import { Server as SocketServer } from 'socket.io';
import { io } from 'socket.io-client';

import { createApp } from '../server/app.js';
import { createAuth } from '../server/auth.js';
import { loadConfig } from '../server/config.js';
import { createDatabase } from '../server/db/index.js';
import { attachSocketServer } from '../server/realtime/socket.js';
import { SessionManager } from '../server/sessions/manager.js';

/**
 * Boot the real HTTP + Socket.IO server against an isolated database.
 * Pass a directory to pgliteDir to test persistence across restarts.
 */
export async function bootTestServer({ pgliteDir = 'memory://' } = {}) {
  const config = loadConfig({
    nodeEnv: 'test',
    port: 0,
    adminPin: '123456',
    cookieSecret: 'test-cookie-secret-0123456789abcdef',
    pgliteDir,
    clientDist: '/nonexistent-cyber-battleships-client',
    publicUrl: 'http://127.0.0.1',
    logLevel: 'silent',
    databaseUrl: '',
  });
  const logger = pino({ level: 'silent' });
  const db = await createDatabase({ config, logger });
  await db.migrate();

  const manager = new SessionManager({ db, config, logger });
  await manager.init();

  const auth = createAuth(config);
  const app = createApp({ config, manager, db, auth, logger });
  const server = http.createServer(app);
  const ioServer = new SocketServer(server, {
    cors: { origin: true, credentials: true },
    allowRequest: (req, callback) => callback(null, true),
  });
  attachSocketServer(ioServer, { manager, config, auth, logger });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let closed = false;

  return {
    config,
    db,
    manager,
    auth,
    server,
    io: ioServer,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => ioServer.close(resolve));
      if (server.listening) {
        await new Promise((resolve) => server.close(() => resolve()));
      }
      await manager.closeAll();
      await db.close();
    },
  };
}

/** Log in as facilitator and return the cookie header value. */
export async function loginHost(baseUrl, pin = '123456') {
  const response = await fetch(`${baseUrl}/api/host/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!response.ok) throw new Error(`Host login failed: HTTP ${response.status}`);
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('Host login did not set a cookie');
  return setCookie.split(';')[0];
}

/** Create a live session through the facilitator HTTP API. */
export async function createSession(baseUrl, cookie, config = {}) {
  const response = await fetch(`${baseUrl}/api/host/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ config }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Create session failed: ${JSON.stringify(body)}`);
  return body.session;
}

/** Connect a socket.io client, optionally with the facilitator cookie. */
export function connect(baseUrl, cookie = null) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: cookie ? { cookie } : {},
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out connecting socket.io client'));
    }, 8000);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

/** Emit an event that expects an acknowledgement payload. */
export function emitAck(socket, event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

/** Poll until fn returns a truthy value, then return it. */
export async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 25, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

/** Collect every state projection a socket receives. */
export function collectStates(socket) {
  const states = [];
  socket.on('state', (state) => states.push(state));
  return {
    states,
    latest() {
      return states.length ? states[states.length - 1] : null;
    },
    find(predicate) {
      for (let index = states.length - 1; index >= 0; index -= 1) {
        if (predicate(states[index])) return states[index];
      }
      return null;
    },
  };
}
