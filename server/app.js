import fs from 'node:fs';
import path from 'node:path';

import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import QRCode from 'qrcode';
import { ZodError } from 'zod';

import { DEFAULT_CONFIG } from '../shared/constants.js';
import { sessionConfigSchema } from '../shared/schemas.js';
import { AppError } from './errors.js';
import { requireHost } from './auth.js';
import { baseUrlFor, displayUrlFor, normaliseJoinCode, shortJoinUrlFor } from './util/security.js';

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function zodMessage(error) {
  return error.issues?.[0]?.message || 'Invalid request.';
}

function isApi(req) {
  return req.path.startsWith('/api/');
}

export function createApp({ config, manager, db, auth, logger }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '96kb' }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === '/healthz' || req.url.startsWith('/assets/'),
      },
      customLogLevel: (req, res, error) => {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'debug';
      },
    }),
  );

  app.get(
    '/healthz',
    asyncHandler(async (req, res) => {
      try {
        const ok = await db.ping();
        res.status(ok ? 200 : 503).json({ ok, db: db.kind, now: Date.now() });
      } catch (error) {
        logger.error({ err: error }, 'Health check failed');
        res.status(503).json({ ok: false, db: db.kind });
      }
    }),
  );

  // ---------------------------------------------------------------- auth

  app.post(
    '/api/host/login',
    asyncHandler(async (req, res) => {
      if (!auth.allowLogin(req.ip)) {
        res.status(429).json({
          error: { code: 'RATE_LIMIT', message: 'Too many attempts. Wait ten minutes and try again.' },
        });
        return;
      }
      const pin = String(req.body?.pin ?? '').trim();
      if (!auth.checkPin(pin)) {
        logger.warn({ ip: req.ip }, 'Failed facilitator login');
        res.status(401).json({
          error: { code: 'INVALID_PIN', message: 'That facilitator PIN is not valid.' },
        });
        return;
      }
      auth.resetLoginAttempts(req.ip);
      const token = auth.createHostToken();
      res.cookie(config.cookieName, token, auth.cookieOptions());
      res.json({ ok: true });
    }),
  );

  app.post('/api/host/logout', (req, res) => {
    res.clearCookie(config.cookieName, auth.clearCookieOptions());
    res.json({ ok: true });
  });

  app.get('/api/host/me', requireHost(auth), (req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/host/sessions', requireHost(auth), (req, res) => {
    res.json({ ok: true, sessions: manager.listSummaries() });
  });

  app.post(
    '/api/host/sessions',
    requireHost(auth),
    asyncHandler(async (req, res) => {
      const raw = req.body?.config && typeof req.body.config === 'object' ? req.body.config : req.body || {};
      const parsed = sessionConfigSchema.parse({ ...DEFAULT_CONFIG, ...raw });
      const baseUrl = baseUrlFor(req, config);
      const session = await manager.create({ config: parsed, baseUrl });
      res.status(201).json({ ok: true, session: session.summary() });
    }),
  );

  app.delete(
    '/api/host/sessions/:id',
    requireHost(auth),
    asyncHandler(async (req, res) => {
      const removed = await manager.remove(req.params.id);
      if (!removed) {
        res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found.' } });
        return;
      }
      res.json({ ok: true });
    }),
  );

  // -------------------------------------------------------------- public

  app.get(
    '/api/sessions/:code',
    asyncHandler(async (req, res) => {
      const session = manager.getByCode(req.params.code);
      if (!session) {
        res.status(404).json({
          error: { code: 'SESSION_NOT_FOUND', message: 'That join code is not valid.' },
        });
        return;
      }
      const summary = manager.publicSummary(session);
      const baseUrl = baseUrlFor(req, config);
      summary.join = {
        ...summary.join,
        url: shortJoinUrlFor(baseUrl, session.joinCode),
        displayUrl: displayUrlFor(baseUrl, session.joinCode),
        qrUrl: `/api/sessions/${encodeURIComponent(session.joinCode)}/qr.svg`,
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, ...summary });
    }),
  );

  app.get(
    '/api/sessions/:code/qr.svg',
    asyncHandler(async (req, res) => {
      const session = manager.getByCode(req.params.code);
      if (!session) {
        res.status(404).type('text/plain').send('Session not found');
        return;
      }
      const url = shortJoinUrlFor(baseUrlFor(req, config), session.joinCode);
      const svg = await QRCode.toString(url, {
        type: 'svg',
        margin: 1,
        width: 360,
        errorCorrectionLevel: 'M',
        color: { dark: '#06111f', light: '#ffffff' },
      });
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(svg);
    }),
  );

  // -------------------------------------------------------------- clients

  const dist = config.clientDist;
  const hasClientBuild = fs.existsSync(dist);
  if (hasClientBuild) {
    app.use(
      express.static(dist, {
        index: false,
        maxAge: config.production ? '1y' : 0,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html') || /\.html$/.test(filePath)) {
            res.setHeader('Cache-Control', 'no-store');
          }
        },
      }),
    );
  }

  const pages = {
    '/': 'index.html',
    '/host': 'host.html',
    '/display': 'display.html',
    '/play': 'play.html',
  };
  for (const [route, file] of Object.entries(pages)) {
    app.get(route, (req, res, next) => {
      if (!hasClientBuild) {
        next();
        return;
      }
      res.sendFile(path.join(dist, file));
    });
  }

  // Short player entry point: /ABC123 -> /play?code=ABC123, so QR codes and
  // printed links stay compact. Only exact six-character join codes qualify;
  // anything else falls through to the regular handlers.
  app.get('/:code([A-Za-z0-9]{6})', (req, res, next) => {
    const code = normaliseJoinCode(req.params.code);
    const session = manager.getByCode(code);
    if (!session) {
      next();
      return;
    }
    res.redirect(302, `/play?code=${encodeURIComponent(session.joinCode)}`);
  });

  app.use((req, res) => {
    if (isApi(req)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
      return;
    }
    if (hasClientBuild) {
      res.sendFile(path.join(dist, 'index.html'));
      return;
    }
    res
      .status(503)
      .type('text/plain')
      .send(
        'Client bundle not built. Run "npm run build" then "npm start", or use "npm run dev" and open the Vite URL.',
      );
  });

  // --------------------------------------------------------------- errors

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({ error: { code: 'VALIDATION', message: zodMessage(error) } });
      return;
    }
    if (error instanceof AppError) {
      res.status(error.status || 400).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON body.' } });
      return;
    }
    logger.error({ err: error, url: req.originalUrl }, 'Unhandled HTTP error');
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong.' } });
  });

  return app;
}
