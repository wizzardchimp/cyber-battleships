import http from 'node:http';

import pino from 'pino';
import { Server as SocketServer } from 'socket.io';

import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/index.js';
import { attachSocketServer } from './realtime/socket.js';
import { SessionManager } from './sessions/manager.js';
import { localIPv4 } from './util/security.js';

const config = loadConfig();
const logger = pino({
  level: config.logLevel,
  redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
});

async function main() {
  const db = await createDatabase({ config, logger });
  await db.migrate();

  const manager = new SessionManager({ db, config, logger });
  await manager.init();

  const auth = createAuth(config);
  const app = createApp({ config, manager, db, auth, logger });
  const server = http.createServer(app);

  const io = new SocketServer(server, {
    maxHttpBufferSize: 1_000_000,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    cors: { origin: true, credentials: true },
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (!origin) {
        callback(null, true);
        return;
      }
      try {
        const parsed = new URL(origin);
        if (parsed.host === req.headers.host) {
          callback(null, true);
          return;
        }
        if (config.allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        if (!config.production && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
          callback(null, true);
          return;
        }
        callback('Origin not allowed', false);
      } catch {
        callback('Invalid origin', false);
      }
    },
  });

  attachSocketServer(io, { manager, config, auth, logger });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const port = server.address().port;
  const lan = localIPv4();
  const localBase = `http://localhost:${port}`;
  const lanBase = lan ? `http://${lan}:${port}` : null;
  const base = config.publicUrl || lanBase || localBase;

  logger.info(
    {
      port,
      database: db.kind,
      publicUrl: config.publicUrl || null,
      activeSessions: manager.sessions.size,
    },
    'Cyber Battleships server online',
  );

  /* eslint-disable no-console */
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════════╗');
  console.log('  ║                 CYBER BATTLESHIPS // ONLINE              ║');
  console.log('  ╚══════════════════════════════════════════════════════════╝');
  console.log(`  Facilitator : ${base}/host`);
  console.log(`  Projector   : ${base}/display`);
  console.log(`  Join        : ${base}/play`);
  if (lanBase && !config.publicUrl) console.log(`  LAN         : ${lanBase}`);
  console.log(`  Database    : ${db.kind}${db.kind === 'pglite' ? ` (${config.pgliteDir})` : ''}`);
  if (config.adminPinGenerated) {
    console.log(`  ADMIN PIN   : ${config.adminPin}   (generated for this run)`);
  }
  if (config.cookieSecretGenerated && config.production) {
    console.log('  WARNING     : COOKIE_SECRET is not set; facilitator logins reset on restart.');
  }
  if (config.production && db.kind === 'pglite') {
    console.log('  WARNING     : Set DATABASE_URL to Railway PostgreSQL for production.');
  }
  console.log('');

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref?.();
    io.close();
    await new Promise((resolve) => server.close(resolve));
    await manager.closeAll();
    await db.close();
    clearTimeout(force);
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (error) => {
    logger.error({ err: error }, 'Unhandled promise rejection');
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start Cyber Battleships');
  process.exit(1);
});
