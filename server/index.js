/**
 * CYBER BATTLESHIPS server entry point.
 *
 * Serves the three client interfaces, the question bank API and a Socket.IO
 * endpoint that keeps every screen in sync. Designed to run on a laptop on the
 * same Wi-Fi as the phones, or on a container host such as Railway.
 */

import http from 'node:http';
import fs from 'node:fs';
import express from 'express';
import { Server as SocketServer } from 'socket.io';

import {
  DATA_DIR,
  HOST_PIN,
  HOST_PIN_GENERATED,
  PORT,
  PUBLIC_DIR,
  SEED_QUESTIONS,
  NODE_ENV,
} from './config.js';
import { BASE_URL, joinUrlFor, qrDataUrlFor, serverDescription } from './network.js';
import { QuestionStore } from './questions/store.js';
import { StateStore } from './persistence.js';
import { Game } from './game/game.js';
import { attachSockets } from './sockets/index.js';

const store = new QuestionStore({ dataDir: DATA_DIR, seedFile: SEED_QUESTIONS });
const persistence = new StateStore({ dataDir: DATA_DIR });
const snapshot = persistence.load();

const game = new Game({
  store,
  snapshot: snapshot && snapshot.version === 1 ? snapshot : null,
});

if (game.players.size) {
  for (const player of game.players.values()) player.connected = false;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    phase: game.phase,
    players: game.players.size,
    questions: store.count,
    uptime: Math.round(process.uptime()),
    ...serverDescription(),
  });
});

app.get('/api/join', async (req, res) => {
  try {
    const url = joinUrlFor(game.code);
    const qr = await qrDataUrlFor(game.code);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ code: game.code, url, qr, phase: game.phase });
  } catch (error) {
    console.error('[qr]', error);
    res.status(500).json({ error: 'Unable to generate join code.' });
  }
});

app.get('/api/questions', (req, res) => {
  // Public read-only list without the answer key, useful for inspection.
  res.json({
    count: store.count,
    topics: [...new Set(store.list().map((question) => question.topic))],
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    phase: game.phase,
    code: game.code,
    gridCount: game.settings.gridCount,
    mode: game.settings.mode,
    players: [...game.players.values()].map((player) => ({
      name: player.name,
      team: game.getTeam(player.teamId)?.name ?? null,
      connected: player.connected,
    })),
    questions: store.count,
  });
});

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  etag: true,
  maxAge: NODE_ENV === 'production' ? '5m' : 0,
  index: 'index.html',
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (req.accepts('html')) {
    res.redirect('/');
    return;
  }
  res.status(404).send('Not found');
});

const server = http.createServer(app);
const io = new SocketServer(server, {
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1.5e6,
  cors: { origin: false },
});

const sockets = attachSockets(io, { game, store });

game.on('change', () => {
  persistence.schedule(game.toJSON());
});

game.resumeAfterRestore();

// Ensure a baseline snapshot exists on first boot.
if (!snapshot) persistence.save(game.toJSON());

server.listen(PORT, '0.0.0.0', () => {
  const info = serverDescription();
  const lines = [
    '',
    '  ██████╗██╗   ██╗██████╗ ███████╗██████╗',
    '  ██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗',
    '  ██║      ╚████╔╝ ██████╔╝█████╗  ██████╔╝',
    '  ██║       ╚██╔╝  ██╔══██╗██╔══╝  ██╔══██╗',
    '  ╚██████╗   ██║   ██████╔╝███████╗██║  ██║',
    '   ╚═════╝   ╚═╝   ╚═════╝ ╚══════╝╚═╝  ╚═╝',
    '            CYBER BATTLESHIPS',
    '',
    `  Display   ${BASE_URL}/display`,
    `  Presenter ${BASE_URL}/host`,
    `  Join      ${BASE_URL}/play   (code ${game.code})`,
    `  PIN       ${HOST_PIN}${HOST_PIN_GENERATED ? '  (generated - set HOST_PIN to fix it)' : ''}`,
    `  Data      ${DATA_DIR}`,
    `  Questions ${store.count}`,
    '',
  ];
  console.log(lines.join('\n'));
  if (BASE_URL.includes('127.0.0.1')) {
    console.warn('  [!] Only a loopback address was detected. Set PUBLIC_URL (or HOST_URL) so phones can connect.');
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or run: PORT=3001 npm start`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

function shutdown(signal) {
  console.log(`\n[${signal}] Saving game state and shutting down...`);
  persistence.flush();
  sockets.stop();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Keep the process alive on unexpected promise rejections, but log clearly.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

export { app, server, game, store, io };
