import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

/** Minimal .env loader so local startup doesn't need an extra dependency. */
export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

/** Build immutable runtime configuration. Tests pass explicit overrides. */
export function loadConfig(overrides = {}) {
  loadDotEnv();

  const nodeEnv = overrides.nodeEnv || process.env.NODE_ENV || 'development';
  const production = nodeEnv === 'production';
  const port = Number.parseInt(String(overrides.port ?? process.env.PORT ?? '3000'), 10);
  const dataDir = path.resolve(overrides.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data'));

  const generatedPin = String(Math.floor(100000 + Math.random() * 900000));
  const adminPin = String(overrides.adminPin ?? process.env.ADMIN_PIN ?? generatedPin);
  const adminPinGenerated = !(overrides.adminPin ?? process.env.ADMIN_PIN);

  const cookieSecret =
    overrides.cookieSecret ||
    process.env.COOKIE_SECRET ||
    crypto.randomBytes(32).toString('hex');
  const cookieSecretGenerated = !(overrides.cookieSecret || process.env.COOKIE_SECRET);

  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const publicUrl = String(
    overrides.publicUrl ?? process.env.PUBLIC_URL ?? (railwayDomain ? `https://${railwayDomain}` : ''),
  ).replace(/\/+$/, '');

  const databaseUrl = overrides.databaseUrl ?? process.env.DATABASE_URL ?? '';
  // Explicit PGSSL wins even in production so a local Docker Postgres without
  // TLS can be used; otherwise default to TLS in production (Railway).
  const pgSsl =
    'pgSsl' in overrides
      ? Boolean(overrides.pgSsl)
      : process.env.PGSSL !== undefined
        ? truthy(process.env.PGSSL)
        : production;

  const config = {
    root: ROOT,
    nodeEnv,
    production,
    isRailway: Boolean(railwayDomain || process.env.RAILWAY_ENVIRONMENT),
    port,
    host: overrides.host || process.env.HOST || '0.0.0.0',
    dataDir,
    clientDist: path.resolve(overrides.clientDist || path.join(ROOT, 'dist', 'client')),
    publicUrl,
    adminPin,
    adminPinGenerated,
    cookieSecret,
    cookieSecretGenerated,
    cookieName: 'cb_host',
    cookieSecure: production && (publicUrl.startsWith('https://') || truthy(process.env.COOKIE_SECURE)),
    sessionRetentionHours: Number(
      overrides.sessionRetentionHours ?? process.env.SESSION_RETENTION_HOURS ?? 24,
    ),
    databaseUrl,
    pgSsl,
    pgliteDir: overrides.pgliteDir ?? process.env.PGLITE_DIR ?? path.join(dataDir, 'pglite'),
    allowedOrigins: String(process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    logLevel: overrides.logLevel || process.env.LOG_LEVEL || (production ? 'info' : 'debug'),
    bcryptRounds: 12,
  };

  if (config.adminPin.length < 4) {
    throw new Error('ADMIN_PIN must contain at least 4 characters.');
  }
  if (config.cookieSecret.length < 24) {
    throw new Error('COOKIE_SECRET must contain at least 24 characters.');
  }
  if (!Number.isFinite(config.port) || config.port < 0) {
    throw new Error('PORT must be a valid port number.');
  }

  return Object.freeze(config);
}
