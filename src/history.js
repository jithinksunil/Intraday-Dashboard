// Downloads historical candles from Fyers into data/candles/<resolution>/<symbol>.csv and keeps
// them up to date: each run fetches only what is missing since the last stored candle.
//
// Usage: npm run history -- [--res 1m,D] [--days N] [--symbols NSE:SBIN-EQ,NSE:TCS-EQ]
//                           [--watchlist config/watchlist.json] [--data data] [--dry-run]
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import fyers from 'fyers-api-v3';
import { CandleStore, istText } from './lib/candleStore.js';
import { loadEnv, requireEnv } from './lib/env.js';
import {
  chunkRanges, DEFAULT_LOOKBACK_DAYS, FatalHistoryError, parseResolution, rangeEnd, RateLimiter, RESOLUTIONS, syncSymbol,
} from './lib/history.js';
import { loadToken } from './lib/token.js';
import { loadWatchlist } from './lib/watchlist.js';

const DAILY_REQUEST_BUDGET = 4500; // Fyers Standard allows 5,000 data-API requests a day
const PER_MINUTE = 40; // Fyers Standard allows 50; staying under leaves room for retries

const { values: args } = parseArgs({
  options: {
    res: { type: 'string', default: '1m,D' },
    days: { type: 'string' },
    symbols: { type: 'string' },
    watchlist: { type: 'string', default: 'config/watchlist.json' },
    data: { type: 'string', default: 'data' },
    'dry-run': { type: 'boolean', default: false },
  },
});

function setup() {
  loadEnv();
  const resolutions = [...new Set(args.res.split(',').map(parseResolution))];
  const days = args.days === undefined ? null : Number(args.days);
  if (days !== null && !(Number.isInteger(days) && days > 0)) throw new Error('--days must be a positive whole number');
  let symbols;
  if (args.symbols) {
    symbols = [...new Set(args.symbols.split(',').map((s) => s.trim()).filter(Boolean))];
  } else {
    const w = loadWatchlist(args.watchlist);
    symbols = [...new Set([...w.quotes, ...w.depth5, ...(w.depth50 ? [w.depth50] : [])])];
  }
  if (!symbols.length) throw new Error('No symbols to fetch');
  return { resolutions, days, symbols };
}

let cfg;
try {
  cfg = setup();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const nowSec = Math.floor(Date.now() / 1000);
const store = new CandleStore(join(args.data, 'candles'));

// ---------- plan ----------
const jobs = [];
for (const res of cfg.resolutions) {
  const lookback = cfg.days ?? (RESOLUTIONS[res].daily ? DEFAULT_LOOKBACK_DAYS.daily : DEFAULT_LOOKBACK_DAYS.intraday);
  const fromSec = nowSec - lookback * 86_400;
  for (const symbol of cfg.symbols) {
    const stored = store.read(symbol, res);
    const start = stored.length ? stored.at(-1).t : fromSec;
    const end = rangeEnd(res, nowSec);
    jobs.push({ symbol, res, fromSec, stored: stored.length, requests: start > end ? 0 : chunkRanges(res, start, end).length });
  }
}
const totalRequests = jobs.reduce((n, j) => n + j.requests, 0);
const minutes = Math.ceil(totalRequests / PER_MINUTE);
console.log(
  `${cfg.symbols.length} symbols x ${cfg.resolutions.join(', ')}: ${totalRequests} requests, about ` +
    `${minutes} min at ${PER_MINUTE}/min (${jobs.filter((j) => j.stored).length} series already stored, fetched incrementally).`,
);
if (totalRequests > DAILY_REQUEST_BUDGET) {
  console.error(
    `That is over the ${DAILY_REQUEST_BUDGET}-request budget for one day (Fyers' free limit is 5,000). ` +
      'Use fewer --symbols, a shorter --days, or split the run across days.',
  );
  process.exit(1);
}
if (args['dry-run'] || totalRequests === 0) {
  if (totalRequests === 0) console.log('Everything is up to date.');
  process.exit(0);
}

// ---------- fetch ----------
let accessToken;
let appId;
try {
  appId = requireEnv('FYERS_APP_ID').FYERS_APP_ID;
  accessToken = loadToken(appId);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
// Logging off: the SDK would otherwise write the access token to a log file.
const model = new fyers.fyersModel({ enableLogging: false });
model.setAppId(appId);
model.setAccessToken(accessToken);

const limiter = new RateLimiter({ perMinute: PER_MINUTE, perSecond: 3 });
const state = { requests: 0, rateLimitHits: 0 };
const log = (msg) => console.log(`  ${msg}`);
let added = 0;
let skipped = 0;

for (const job of jobs) {
  if (!job.requests) continue;
  try {
    const r = await syncSymbol({
      getHistory: (p) => model.getHistory(p), store, symbol: job.symbol, res: job.res,
      fromSec: job.fromSec, nowSec, limiter, state, log,
    });
    added += Math.max(0, r.added);
    skipped += r.skippedChunks;
    const last = store.read(job.symbol, job.res).at(-1);
    console.log(
      `${job.symbol.padEnd(24)} ${job.res.padEnd(4)} +${String(r.added).padStart(6)}  total ${String(r.total).padStart(7)}` +
        (last ? `  last ${istText(last.t)} IST` : '  (no data returned)'),
    );
  } catch (err) {
    if (err instanceof FatalHistoryError) {
      console.error(`\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

console.log(
  `\nDone: ${added} new candles, ${state.requests} requests` +
    (skipped ? `, ${skipped} request range(s) skipped (see messages above)` : '') +
    `. Files in ./${join(args.data, 'candles')}/`,
);
