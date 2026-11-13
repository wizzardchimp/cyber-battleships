import fs from 'node:fs';
import path from 'node:path';

import compression from 'compression';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import QRCode from 'qrcode';
import { ZodError } from 'zod';

import { AppError } from './errors.js';
import { parseQuestionsCsv, serializeQuestions } from './questions/csv.js';
import { MAX_VAULT_LISTS, isVaultId } from './questions/store.js';
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

export function createApp({ config, manager, db, logger }) {
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
  app.use(express.json({ limit: '1mb' }));
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

  // ------------------------------------------------------ question sets

  /** Only the game screen that started the game holds the control key. */
  function requireControl(req) {
    const session = manager.current();
    const key = String(req.get('x-control-key') || '');
    if (!session || !key || !manager.keyMatches(session, key)) {
      throw new AppError('UNAUTHORIZED', 'Only the game screen can manage questions.', 401);
    }
    return session;
  }

  function requireSet(req) {
    const id = String(req.params.set || '');
    if (!manager.questions.has(id)) {
      throw new AppError('SET_NOT_FOUND', 'That question set does not exist.', 404);
    }
    return id;
  }

  app.get('/api/questions', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, sets: manager.questions.summaries() });
  });

  app.get(
    '/api/questions/:set/export.csv',
    asyncHandler(async (req, res) => {
      requireControl(req);
      const id = requireSet(req);
      const csv = serializeQuestions(manager.questions.questionsFor(id));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="cyber-battleships-${id}-questions.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(csv);
    }),
  );

  app.post(
    '/api/questions/:set/import',
    asyncHandler(async (req, res) => {
      const session = requireControl(req);
      const id = requireSet(req);
      const result = parseQuestionsCsv(req.body?.csv, { setId: id });
      if (!result.ok) {
        res.status(422).json({
          error: { code: 'INVALID_CSV', message: 'The file has problems. Nothing was changed.' },
          errors: result.errors,
          warnings: result.warnings,
        });
        return;
      }
      const preview = result.questions.slice(0, 3).map((question) => ({
        category: question.category,
        prompt: question.prompt,
      }));
      if (req.body?.dryRun) {
        res.json({ ok: true, dryRun: true, count: result.total, warnings: result.warnings, preview });
        return;
      }
      if (session.phase !== 'lobby') {
        throw new AppError('NOT_IN_LOBBY', 'Questions can only be changed in the lobby.', 409);
      }
      await manager.questions.replace(id, result.questions);
      session.emit('change');
      res.json({ ok: true, count: result.total, warnings: result.warnings, preview });
    }),
  );

  // The vault: lists the host has imported, kept for future games.
  app.post(
    '/api/vault',
    asyncHandler(async (req, res) => {
      const session = requireControl(req);
      const name = String(req.body?.name ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
      if (name.length < 2) {
        throw new AppError('INVALID_NAME', 'Give the list a name of at least two characters.', 422);
      }
      const result = parseQuestionsCsv(req.body?.csv, { setId: 'vault' });
      if (!result.ok) {
        res.status(422).json({
          error: { code: 'INVALID_CSV', message: 'The file has problems. Nothing was saved.' },
          errors: result.errors,
          warnings: result.warnings,
        });
        return;
      }
      const preview = result.questions.slice(0, 3).map((question) => ({
        category: question.category,
        prompt: question.prompt,
      }));
      if (req.body?.dryRun) {
        res.json({ ok: true, dryRun: true, count: result.total, warnings: result.warnings, preview });
        return;
      }
      if (session.phase !== 'lobby') {
        throw new AppError('NOT_IN_LOBBY', 'Questions can only be changed in the lobby.', 409);
      }
      if (manager.questions.vaultCount() >= MAX_VAULT_LISTS) {
        throw new AppError('VAULT_FULL', `The vault holds up to ${MAX_VAULT_LISTS} lists. Delete one first.`, 409);
      }
      const id = await manager.questions.createVault(name, result.questions);
      // A newly imported list is the one this game uses.
      await session.updateConfig({ questionSet: id });
      session.emit('change');
      res.json({ ok: true, id, count: result.total, warnings: result.warnings, preview, sets: manager.questions.summaries() });
    }),
  );

  app.delete(
    '/api/vault/:id',
    asyncHandler(async (req, res) => {
      const session = requireControl(req);
      const id = String(req.params.id || '');
      if (!isVaultId(id) || !manager.questions.has(id)) {
        throw new AppError('SET_NOT_FOUND', 'That list is not in the vault.', 404);
      }
      if (session.phase !== 'lobby') {
        throw new AppError('NOT_IN_LOBBY', 'Questions can only be changed in the lobby.', 409);
      }
      if (session.config.questionSet === id) await session.updateConfig({ questionSet: 'easy' });
      await manager.questions.removeVault(id);
      session.emit('change');
      res.json({ ok: true, sets: manager.questions.summaries() });
    }),
  );

  app.post(
    '/api/questions/:set/reset',
    asyncHandler(async (req, res) => {
      const session = requireControl(req);
      const id = requireSet(req);
      if (session.phase !== 'lobby') {
        throw new AppError('NOT_IN_LOBBY', 'Questions can only be changed in the lobby.', 409);
      }
      await manager.questions.reset(id);
      session.emit('change');
      res.json({ ok: true, sets: manager.questions.summaries() });
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
    '/display': 'display.html',
    '/play': 'play.html',
  };
  app.get('/host', (req, res) => res.redirect(302, '/display'));
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
