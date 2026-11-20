import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { istDate } from './time.js';

export const TOKEN_PATH = '.secrets/fyers-token.json';

/** Reads the `exp` claim (epoch ms) from a JWT without verifying it. Null if absent. */
export function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function saveToken({ appId, accessToken }, path = TOKEN_PATH) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record = {
    appId,
    accessToken,
    istDate: istDate(),
    expiresAt: jwtExpiryMs(accessToken),
    createdAt: Date.now(),
  };
  writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  return record;
}

/** Returns the saved access token, or throws with the fix if it is missing, foreign or expired. */
export function loadToken(appId, { path = TOKEN_PATH, now = Date.now() } = {}) {
  if (!existsSync(path)) throw new Error('No saved Fyers token. Run: npm run login');
  const t = JSON.parse(readFileSync(path, 'utf8'));
  if (t.appId !== appId) {
    throw new Error('Saved token was issued for a different FYERS_APP_ID. Run: npm run login');
  }
  const expired = t.expiresAt ? now >= t.expiresAt : t.istDate !== istDate(now);
  if (expired) throw new Error('Saved Fyers token has expired (they last one day). Run: npm run login');
  return t.accessToken;
}
