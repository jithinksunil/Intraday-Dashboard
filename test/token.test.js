import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jwtExpiryMs, loadToken, saveToken } from '../src/lib/token.js';

const jwt = (payload) =>
  ['{"alg":"none"}', JSON.stringify(payload)].map((p) => Buffer.from(p).toString('base64url')).join('.') + '.sig';

test('jwtExpiryMs reads exp, tolerates junk', () => {
  assert.equal(jwtExpiryMs(jwt({ exp: 1763500000 })), 1763500000000);
  assert.equal(jwtExpiryMs(jwt({})), null);
  assert.equal(jwtExpiryMs('not-a-jwt'), null);
});

test('saved token loads until it expires, and only for its own app id', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tok-')), 'sub', 'token.json');
  const token = jwt({ exp: 2_000_000_000 });
  saveToken({ appId: 'APP-100', accessToken: token }, path);
  assert.equal(loadToken('APP-100', { path, now: 1_999_999_999_000 }), token);
  assert.throws(() => loadToken('APP-100', { path, now: 2_000_000_000_000 }), /expired/);
  assert.throws(() => loadToken('OTHER-100', { path, now: 0 }), /different FYERS_APP_ID/);
  assert.throws(() => loadToken('APP-100', { path: path + '.missing' }), /npm run login/);
});
