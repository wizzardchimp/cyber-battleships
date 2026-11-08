import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuth } from '../server/auth.js';

const SECRET = 'test-cookie-secret-0123456789abcdef';
const config = {
  cookieSecret: SECRET,
  adminPin: '123456',
  cookieName: 'cb_host',
  cookieSecure: false,
};
const auth = createAuth(config);

test('facilitator tokens verify and are bound to the cookie secret', () => {
  const token = auth.createHostToken();
  assert.equal(auth.verifyHostToken(token), true);

  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(auth.verifyHostToken(tampered), false);
  assert.equal(auth.verifyHostToken(''), false);
  assert.equal(auth.verifyHostToken('not-a-token'), false);

  const other = createAuth({ ...config, cookieSecret: 'a-different-secret-0123456789abcd' });
  assert.equal(other.verifyHostToken(token), false);
});

test('expired facilitator tokens are rejected', () => {
  const expired = auth.createHostToken(Date.now() - (auth.maxAgeMs + 60_000));
  assert.equal(auth.verifyHostToken(expired), false);

  const valid = auth.createHostToken(Date.now() - 60_000);
  assert.equal(auth.verifyHostToken(valid), true);

  const future = Date.now() + auth.maxAgeMs + 60_000;
  assert.equal(auth.verifyHostToken(valid, future), false);
});

test('PIN comparison accepts only the configured PIN', () => {
  assert.equal(auth.checkPin('123456'), true);
  assert.equal(auth.checkPin(' 123456 '), true);
  assert.equal(auth.checkPin('000000'), false);
  assert.equal(auth.checkPin(''), false);
  assert.equal(auth.checkPin(null), false);
});

test('login attempts are throttled per IP and reset after success', () => {
  const local = createAuth(config);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    assert.equal(local.allowLogin('203.0.113.7'), true, `attempt ${attempt}`);
  }
  assert.equal(local.allowLogin('203.0.113.7'), false);
  assert.equal(local.allowLogin('203.0.113.8'), true, 'other IPs are independent');

  local.resetLoginAttempts('203.0.113.7');
  assert.equal(local.allowLogin('203.0.113.7'), true);
});

test('request authentication reads the signed cookie', () => {
  const token = auth.createHostToken();
  const request = (cookie) => ({ headers: cookie ? { cookie } : {} });

  assert.equal(auth.isHostRequest(request(`cb_host=${token}`)), true);
  assert.equal(auth.isHostRequest(request(`other=${token}`)), false);
  assert.equal(auth.isHostRequest(request('cb_host=broken')), false);
  assert.equal(auth.isHostRequest(request(null)), false);

  const socket = { request: { headers: { cookie: `cb_host=${token}` } } };
  assert.equal(auth.authenticateSocket(socket), true);
});
