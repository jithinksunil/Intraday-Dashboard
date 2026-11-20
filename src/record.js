// Records live Fyers market data to data/<IST date>/:
//   quotes-*.ndjson.gz   stock quotes (q) and index values (i)   - data socket
//   depth5-*.ndjson.gz   5-level order book (d5)                 - data socket
//   depth50-*.ndjson.gz  50-level order book (d50), one symbol   - TBT socket
//   events-*.ndjson.gz   connects, errors, subscribe acks, per-minute health
//
// Usage: npm run record [-- --until 15:35] [--no-tbt] [--watchlist config/watchlist.json] [--data data]
import { parseArgs } from 'node:util';
import fyers from 'fyers-api-v3';
import { TbtClient } from './feeds/tbtClient.js';
import { loadEnv, requireEnv } from './lib/env.js';
import { FyersMessageNormalizer } from './lib/normalize.js';
import { TbtBooks } from './lib/tbtBook.js';
import { inMarketHours, istClock, istMinutes, parseHHMM } from './lib/time.js';
import { loadToken } from './lib/token.js';
import { loadWatchlist } from './lib/watchlist.js';
import { DailyGzipWriter } from './lib/writer.js';

const { values: args } = parseArgs({
  options: {
    until: { type: 'string', default: '15:35' },
    'no-tbt': { type: 'boolean', default: false },
    watchlist: { type: 'string', default: 'config/watchlist.json' },
    data: { type: 'string', default: 'data' },
  },
});

const HEALTH_EVERY_MS = 60_000;
const DATA_STALE_EXIT_MS = 3 * 60_000; // data socket silent this long in market hours -> exit(2)
const TBT_STALE_KICK_MS = 90_000; // TBT silent this long in market hours -> reconnect

// ---------- setup ----------
function setup() {
  loadEnv();
  const { FYERS_APP_ID } = requireEnv('FYERS_APP_ID');
  const accessToken = loadToken(FYERS_APP_ID);
  return { authKey: `${FYERS_APP_ID}:${accessToken}`, watch: loadWatchlist(args.watchlist) };
}
let config;
try {
  config = setup();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const { authKey, watch } = config;
const useTbt = Boolean(watch.depth50) && !args['no-tbt'];

const untilMin = args.until === 'none' ? null : parseHHMM(args.until);
if (untilMin !== null && istMinutes() >= untilMin) {
  console.error(`It is already past --until ${args.until} IST. Pass --until none to record anyway.`);
  process.exit(1);
}

const writers = {
  quotes: new DailyGzipWriter({ root: args.data, stream: 'quotes' }),
  depth5: new DailyGzipWriter({ root: args.data, stream: 'depth5' }),
  depth50: new DailyGzipWriter({ root: args.data, stream: 'depth50' }),
  events: new DailyGzipWriter({ root: args.data, stream: 'events' }),
};

function event(kind, detail = {}, { print = true } = {}) {
  writers.events.write({ k: 'ev', ev: kind, recv: Date.now(), ...detail });
  if (print) console.log(`[${istClock()} IST] ${kind}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
}

for (const w of watch.warnings) console.warn(`warning: ${w}`);

// ---------- stats ----------
const stats = {
  data: { lastAt: 0, armed: false },
  tbt: { lastAt: 0 },
  window: { q: 0, i: 0, d5: 0, d50: 0, seqJumps: 0 },
  lastBySym: new Map(),
};

function countRecord(rec) {
  stats.window[rec.k]++;
  stats.lastBySym.set(rec.sym, rec.recv);
  if (rec.seqJump) stats.window.seqJumps++;
}

// ---------- data socket (quotes + 5-level depth) ----------
const normalizer = new FyersMessageNormalizer();
// Third argument false turns SDK file logging off (it would log the access token).
const dataSocket = fyers.fyersDataSocket.getInstance(authKey, 'logs', false);

dataSocket.on('connect', () => {
  event('data.connect', { quotes: watch.quotes.length, depth5: watch.depth5.length });
  if (watch.quotes.length) dataSocket.subscribe(watch.quotes);
  if (watch.depth5.length) dataSocket.subscribe(watch.depth5, true);
});

dataSocket.on('message', (raw) => {
  const recv = Date.now();
  let msgs = raw;
  if (typeof raw === 'string') {
    try {
      msgs = JSON.parse(raw);
    } catch {
      event('data.unparsed', { raw: raw.slice(0, 200) });
      return;
    }
  }
  for (const msg of [].concat(msgs)) {
    const rec = normalizer.normalize(msg, recv);
    if (!rec) {
      handleControl(msg);
      continue;
    }
    stats.data.lastAt = recv;
    if (inMarketHours(recv)) stats.data.armed = true;
    (rec.k === 'd5' ? writers.depth5 : writers.quotes).write(rec);
    countRecord(rec);
  }
});

function handleControl(msg) {
  const isError = msg?.s === 'error' || msg?.code < 0;
  event(isError ? 'data.error' : 'data.control', { msg }, { print: isError || msg?.type === 'cn' });
  const text = String(msg?.message ?? '').toLowerCase();
  if (isError && /token|auth|expired|login/.test(text)) {
    shutdown(1, 'The data socket rejected the token. Run: npm run login');
  }
}

dataSocket.on('error', (err) => event('data.socket_error', { error: String(err?.message ?? JSON.stringify(err)) }));
dataSocket.on('close', () => event('data.close'));
dataSocket.autoreconnect(50);
dataSocket.connect();

// ---------- TBT socket (50-level depth, one symbol on the free plan) ----------
let tbt = null;
if (useTbt) {
  const books = new TbtBooks();
  tbt = new TbtClient({ authKey, symbols: [watch.depth50] });
  tbt.on('open', () => event('tbt.open', { symbol: watch.depth50 }));
  tbt.on('packet', (msg, recv) => {
    stats.tbt.lastAt = recv;
    for (const rec of books.apply(msg, recv)) {
      writers.depth50.write(rec);
      countRecord(rec);
    }
  });
  tbt.on('servererror', (m) => event('tbt.server_error', { msg: m }));
  tbt.on('error', (err) => event('tbt.error', { error: err.message }));
  tbt.on('close', (code, reason) => event('tbt.close', { code, reason }));
  tbt.on('reconnecting', (delay) => event('tbt.reconnecting', { inMs: delay }));
  tbt.on('fatal', (err) =>
    event('tbt.fatal', {
      error: err.message,
      hint: 'Token rejected or no TBT access. Quotes and 5-level depth keep recording.',
    }),
  );
  tbt.start();
} else {
  event('tbt.disabled', { reason: watch.depth50 ? '--no-tbt' : 'no depth50 symbol in watchlist' });
}

// ---------- health line, watchdogs, scheduled stop ----------
const health = setInterval(() => {
  const now = Date.now();
  const w = stats.window;
  const silent = [...watch.quotes, ...watch.depth5, ...(useTbt ? [watch.depth50] : [])].filter(
    (s) => now - (stats.lastBySym.get(s) ?? 0) > 120_000,
  );
  const market = inMarketHours(now);
  event(
    'health',
    { perMin: { ...w }, silent: [...new Set(silent)], market },
    { print: false },
  );
  console.log(
    `[${istClock(now)} IST] per min: quotes ${w.q} | index ${w.i} | depth5 ${w.d5} | depth50 ${w.d50}` +
      (w.seqJumps ? ` (seq jumps ${w.seqJumps})` : '') +
      (market && silent.length ? ` | silent >2m: ${[...new Set(silent)].join(', ')}` : '') +
      (market ? '' : ' | outside market hours'),
  );
  stats.window = { q: 0, i: 0, d5: 0, d50: 0, seqJumps: 0 };

  if (market && stats.data.armed && now - stats.data.lastAt > DATA_STALE_EXIT_MS) {
    shutdown(2, 'Data socket silent for 3 minutes during market hours; exiting so a restart loop can reconnect.');
  }
  if (tbt && market && stats.tbt.lastAt && now - stats.tbt.lastAt > TBT_STALE_KICK_MS) {
    event('tbt.stale_reconnect');
    stats.tbt.lastAt = now;
    tbt.kick();
  }
  if (untilMin !== null && istMinutes(now) >= untilMin) {
    shutdown(0, `Reached --until ${args.until} IST.`);
  }
}, HEALTH_EVERY_MS);

let shuttingDown = false;
async function shutdown(code, why) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(health);
  event('shutdown', { code, why });
  try {
    tbt?.stop();
    dataSocket.close();
  } catch {
    // already closed
  }
  await Promise.all(Object.values(writers).map((w) => w.close()));
  const counts = Object.entries(writers)
    .map(([name, w]) => `${name} ${w.count}`)
    .join(', ');
  console.log(`Records written: ${counts}`);
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0, 'Interrupted'));
process.on('SIGTERM', () => shutdown(0, 'Terminated'));

console.log(
  `Recording ${watch.quotes.length} quotes, ${watch.depth5.length} depth5` +
    (useTbt ? `, depth50 ${watch.depth50}` : '') +
    ` to ./${args.data}/ until ${untilMin === null ? 'stopped' : `${args.until} IST`}. Ctrl+C to stop.`,
);
