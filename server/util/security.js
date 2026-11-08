import crypto from 'node:crypto';
import os from 'node:os';

import { CODE_ALPHABET, LIMITS } from '../../shared/constants.js';
import { normaliseCode } from '../../shared/util.js';

export function makeJoinCode(length = LIMITS.joinCodeLength) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

export function makePlayerToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function normaliseJoinCode(value) {
  return normaliseCode(value).slice(0, LIMITS.joinCodeLength);
}

/** Best-effort LAN address so a QR code works without PUBLIC_URL. */
export function localIPv4() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      candidates.push(entry.address);
    }
  }
  const preferred = candidates.find(
    (address) =>
      address.startsWith('192.168.') ||
      address.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(address),
  );
  return preferred || candidates[0] || null;
}

export function baseUrlFor(req, config) {
  if (config.publicUrl) return config.publicUrl;
  const host = req?.get?.('host');
  const forwardedProto = String(req?.get?.('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req?.protocol || 'http';
  if (host && !/^(localhost|127\.0\.0\.1|\[::1\])(?::|$)/i.test(host)) {
    return `${protocol}://${host}`;
  }
  const lan = localIPv4();
  if (lan) return `http://${lan}:${config.port}`;
  return `${protocol}://${host || `localhost:${config.port}`}`;
}

export function joinUrlFor(baseUrl, code) {
  return `${String(baseUrl).replace(/\/+$/, '')}/play?code=${encodeURIComponent(code)}`;
}

export function displayUrlFor(baseUrl, code) {
  return `${String(baseUrl).replace(/\/+$/, '')}/display?code=${encodeURIComponent(code)}`;
}
