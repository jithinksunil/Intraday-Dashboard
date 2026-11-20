// Interactive daily login: prints the Fyers login URL, takes the redirected URL back,
// exchanges the auth code for an access token and saves it to .secrets/.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import readline from 'node:readline/promises';
import fyers from 'fyers-api-v3';
import { loadEnv, requireEnv } from './lib/env.js';
import { saveToken, TOKEN_PATH } from './lib/token.js';

const require = createRequire(import.meta.url);
const { Config } = require('fyers-api-v3/config/config.js');

let env;
try {
  loadEnv();
  env = requireEnv('FYERS_APP_ID', 'FYERS_SECRET_KEY', 'FYERS_REDIRECT_URI');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Keep SDK logging off: with logging on, fyers-api-v3 writes the secret key and auth code
// to a plain-text log file in the working directory.
const model = new fyers.fyersModel({ enableLogging: false });
model.setAppId(env.FYERS_APP_ID);
model.setRedirectUrl(env.FYERS_REDIRECT_URI);

// Built here rather than with model.generateAuthCode(), which does not URL-encode redirect_uri.
const state = randomBytes(8).toString('hex');
const loginUrl = new URL(`${Config.SYNC_API}/generate-authcode`);
loginUrl.search = new URLSearchParams({
  client_id: env.FYERS_APP_ID,
  redirect_uri: env.FYERS_REDIRECT_URI,
  response_type: 'code',
  state,
}).toString();

console.log('\n1. Open this URL and log in to Fyers yourself:\n');
console.log(`   ${loginUrl}\n`);
console.log('2. After login the browser goes to your redirect URL (the page itself may fail to');
console.log('   load; that is fine). Copy the full address from the address bar.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pasted = (await rl.question('Paste the redirected URL (or just the auth_code): ')).trim();
rl.close();

let authCode = pasted;
if (pasted.includes('auth_code=')) {
  const params = new URL(pasted).searchParams;
  if (params.get('s') && params.get('s') !== 'ok') {
    console.error(`Fyers reported a login failure: ${params.get('message') ?? params.get('s')}`);
    process.exit(1);
  }
  if (params.get('state') && params.get('state') !== state) {
    console.error('The state in that URL does not match this login attempt. Run npm run login again.');
    process.exit(1);
  }
  authCode = params.get('auth_code');
}
if (!authCode) {
  console.error('No auth_code found in what you pasted.');
  process.exit(1);
}

const res = await model.generate_access_token({
  client_id: env.FYERS_APP_ID,
  secret_key: env.FYERS_SECRET_KEY,
  auth_code: authCode,
});
if (res?.s !== 'ok' || !res.access_token) {
  console.error(`Token exchange failed: ${res?.message ?? 'unknown error'} (code ${res?.code ?? '?'})`);
  process.exit(1);
}

model.setAccessToken(res.access_token);
try {
  const profile = await model.get_profile();
  if (profile?.s !== 'ok') throw new Error(profile?.message ?? 'profile call failed');
} catch (err) {
  console.error(`Got a token but the profile check failed: ${err.message ?? err}`);
  process.exit(1);
}

const saved = saveToken({ appId: env.FYERS_APP_ID, accessToken: res.access_token });
const until = saved.expiresAt ? new Date(saved.expiresAt).toLocaleString() : 'end of day';
console.log(`\nLogged in. Token saved to ${TOKEN_PATH} (valid until ${until}).`);
console.log('Next: npm run record');
