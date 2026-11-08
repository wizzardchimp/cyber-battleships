import crypto from 'node:crypto';
import { parse as parseCookie } from 'cookie';

import { LIMITS } from '../shared/constants.js';
import { safeEqual } from './util/security.js';

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function createAuth(config) {
  const maxAgeMs = LIMITS.hostCookieHours * 60 * 60 * 1000;
  const attempts = new Map();

  function createHostToken(now = Date.now()) {
    const payload = b64url(JSON.stringify({ sub: 'host', iat: now, exp: now + maxAgeMs }));
    return `${payload}.${sign(payload, config.cookieSecret)}`;
  }

  function verifyHostToken(token, now = Date.now()) {
    if (!token || typeof token !== 'string') return false;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return false;
    const payload = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    const expected = sign(payload, config.cookieSecret);
    if (!safeEqual(signature, expected)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return data.sub === 'host' && Number(data.exp) > now;
    } catch {
      return false;
    }
  }

  function readCookies(cookieHeader) {
    try {
      return parseCookie(cookieHeader || '');
    } catch {
      return {};
    }
  }

  function requestToken(req) {
    const cookies = readCookies(req.headers?.cookie);
    return cookies[config.cookieName] || null;
  }

  function isHostRequest(req) {
    return verifyHostToken(requestToken(req));
  }

  function authenticateSocket(socket) {
    const cookieHeader = socket.request?.headers?.cookie;
    const cookies = readCookies(cookieHeader);
    return verifyHostToken(cookies[config.cookieName]);
  }

  function checkPin(pin) {
    return safeEqual(String(pin ?? '').trim(), config.adminPin);
  }

  function cookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: maxAgeMs,
      path: '/',
    };
  }

  function clearCookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
    };
  }

  /** Simple per-IP login throttle. */
  function allowLogin(ip, now = Date.now()) {
    const key = String(ip || 'unknown');
    const windowMs = 10 * 60 * 1000;
    let entry = attempts.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      attempts.set(key, entry);
    }
    entry.count += 1;
    if (attempts.size > 5000) {
      for (const [candidate, value] of attempts) {
        if (now > value.resetAt) attempts.delete(candidate);
      }
    }
    return entry.count <= 8;
  }

  function resetLoginAttempts(ip) {
    attempts.delete(String(ip || 'unknown'));
  }

  return {
    createHostToken,
    verifyHostToken,
    isHostRequest,
    authenticateSocket,
    checkPin,
    cookieOptions,
    clearCookieOptions,
    allowLogin,
    resetLoginAttempts,
    maxAgeMs,
  };
}

export function requireHost(auth) {
  return (req, res, next) => {
    if (!auth.isHostRequest(req)) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Facilitator login required.' } });
      return;
    }
    next();
  };
}
