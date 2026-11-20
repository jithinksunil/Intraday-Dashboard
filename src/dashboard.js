// Real-time dashboard server. On start it runs the stock-selection scan (Intraday Learning/
// StockSelection) on the latest completed session and shows the selected stocks. It then brings
// their 1-minute history up to date (needed for the RVOL baseline), subscribes to live quotes
// and pushes RVOL to the browser on every update.
//
// Usage: npm run dashboard [-- --port 4000] [--lan] [--top 20] [--no-scan] [--config config/dashboard.json] [--data data]
// --no-scan skips the selection and shows the fixed list in the config file, which is also the
// fallback when the scan fails or selects nothing.
// --lan also serves other devices on the same network (phone on the same Wi-Fi); default is this machine only.
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import fyers from 'fyers-api-v3';
import { CandleStore } from './lib/candleStore.js';
import { createDashboardServer } from './lib/dashboardServer.js';
import { loadEnv, requireEnv } from './lib/env.js';
import { FlowStore } from './lib/flowStore.js';
import { FatalHistoryError, RateLimiter, syncSymbol } from './lib/history.js';
import { FyersMessageNormalizer } from './lib/normalize.js';
import { RvolEngine } from './lib/rvolEngine.js';
import { inMarketHours, istClock } from './lib/time.js';
import { loadToken } from './lib/token.js';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '4000' },
    lan: { type: 'boolean', default: false },
    config: { type: 'string', default: 'config/dashboard.json' },
    top: { type: 'string', default: '20' },
    'no-scan': { type: 'boolean', default: false },
    data: { type: 'string', default: 'data' },
  },
});

const MAX_SYMBOLS = 50; // each uses a quote and a depth subscription, and the Fyers free plan allows 100
const FIRST_LOAD_DAYS = 45; // enough for a 20-session baseline when a symbol has no stored candles
const log = (msg) => console.log(`[${istClock()} IST] ${msg}`);

let symbols;
let appId;
let accessToken;
try {
  loadEnv();
  symbols = JSON.parse(readFileSync(args.config, 'utf8')).symbols;
  if (!Array.isArray(symbols) || !symbols.length) throw new Error(`${args.config} needs a non-empty "symbols" array`);
  if (symbols.length > MAX_SYMBOLS) throw new Error(`At most ${MAX_SYMBOLS} symbols: each uses a quote and a depth subscription, and the Fyers free plan allows 100`);
  if (!(Number.isInteger(Number(args.top)) && Number(args.top) >= 1 && Number(args.top) <= MAX_SYMBOLS)) throw new Error(`--top must be a whole number from 1 to ${MAX_SYMBOLS}`);
  appId = requireEnv('FYERS_APP_ID').FYERS_APP_ID;
  accessToken = loadToken(appId);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const store = new CandleStore(join(args.data, 'candles'));
// Logging off: the SDK would otherwise write the access token to a log file.
const model = new fyers.fyersModel({ enableLogging: false });
model.setAppId(appId);
model.setAccessToken(accessToken);
const limiter = new RateLimiter({ perMinute: 40, perSecond: 3 });
const historyState = { requests: 0, rateLimitHits: 0 };

// Stock selection: the scan's matches, best score first, replace the fixed config list.
// `selection` tells the page where its list came from, for the side panel's "?" explanation.
let selection = { source: 'config' };
if (!args['no-scan']) {
  log('selecting stocks from the latest completed session (about 3 minutes if not scanned since the close)...');
  try {
    const { main: scan } = await import('../Intraday Learning/StockSelection/scan-intraday.js');
    const report = await scan(['--completed'], { limiter }); // shares the limiter: one request allowance per account
    const picked = report.matches.slice(0, Number(args.top)).map((row) => row.fyers);
    if (picked.length) {
      symbols = picked;
      selection = { source: 'scan', session: report.session, matched: report.matchedCount, shown: picked.length, evaluated: report.evaluatedCount, config: report.config };
      log(`showing ${picked.length} of ${report.matchedCount} stocks selected from the ${report.session} session`);
    } else {
      log(`the scan selected no stocks for ${report.session}; showing the list in ${args.config}`);
    }
  } catch (err) {
    if (err instanceof FatalHistoryError) {
      console.error(err.message);
      process.exit(1);
    }
    log(`stock selection failed (${err.message}); showing the list in ${args.config}`);
  }
}

/** Brings stored 1-minute candles up to date. Returns the symbols that could not be refreshed. */
async function refreshHistory(list) {
  const failed = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const symbol of list) {
    try {
      const r = await syncSymbol({
        getHistory: (p) => model.getHistory(p), store, symbol, res: '1m',
        fromSec: nowSec - FIRST_LOAD_DAYS * 86_400, nowSec, limiter, state: historyState, log,
      });
      if (r.skippedChunks) failed.push(symbol);
    } catch (err) {
      if (err instanceof FatalHistoryError) throw err;
      failed.push(symbol);
      log(`history refresh failed for ${symbol}: ${err.message ?? err}`);
    }
  }
  return failed;
}

log(`loading 1-minute history for ${symbols.length} symbols...`);
try {
  const failed = await refreshHistory(symbols);
  log(failed.length ? `history loaded, except: ${failed.join(', ')}` : `history up to date (${historyState.requests} requests)`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const status = { feed: 'connecting', since: Date.now(), selection };
const engine = new RvolEngine({
  symbols,
  loadCandles: (sym) => store.read(sym, '1m'),
  // The server ran past midnight: pull yesterday's candles so the new day's baseline includes them.
  onNewDay: (sym) => refreshHistory([sym]).then(() => engine.reload(sym)).catch((err) => log(err.message)),
  // Estimated order flow is kept on disk so a restart during the session keeps the day's CVD.
  flowStore: new FlowStore(join(args.data, 'flow')),
});
const FLOW_SAVE_MS = 60_000;
const flowSaver = setInterval(() => {
  try {
    engine.saveFlow();
  } catch (err) {
    log(`could not save order flow: ${err.message}`);
  }
}, FLOW_SAVE_MS);
const dash = createDashboardServer({ engine, getStatus: () => status });

function setFeed(feed) {
  if (status.feed === feed) return;
  Object.assign(status, { feed, since: Date.now() });
  dash.broadcast({ type: 'status', status });
  log(`feed ${feed}`);
}

const normalizer = new FyersMessageNormalizer();
const socket = fyers.fyersDataSocket.getInstance(`${appId}:${accessToken}`, 'logs', false);
socket.on('connect', () => {
  setFeed('connected');
  engine.markFeedGap(); // volume traded while disconnected stays unclassified
  socket.subscribe(symbols);
  socket.subscribe(symbols, true); // 5-level order book
});
socket.on('message', (raw) => {
  let msgs = raw;
  if (typeof raw === 'string') {
    try {
      msgs = JSON.parse(raw);
    } catch {
      return;
    }
  }
  for (const msg of [].concat(msgs)) {
    const rec = normalizer.normalize(msg);
    if (rec) {
      const row = rec.k === 'd5' ? engine.onDepth(rec) : engine.onQuote(rec);
      if (row) dash.broadcast({ type: 'row', row });
    } else if (msg?.s === 'error' || msg?.code < 0) {
      log(`feed error: ${JSON.stringify(msg)}`);
      if (/token|auth|expired|login/i.test(String(msg?.message ?? ''))) {
        console.error('Fyers rejected the token. Run: npm run login');
        process.exit(1);
      }
    }
  }
});
socket.on('error', (err) => log(`socket error: ${err?.message ?? JSON.stringify(err)}`));
socket.on('close', () => setFeed('disconnected'));
socket.autoreconnect(50);
socket.connect();

// During market hours, pull the latest completed candles every 5 minutes. This keeps the
// 5-minute ATR current and replaces chart points built from live quotes with official candles.
// 10 symbols = 10 requests per refresh, far inside the 50/minute and 5,000/day limits.
const REFRESH_MS = 5 * 60_000;
let refreshing = false;
const refresher = setInterval(async () => {
  if (refreshing || !inMarketHours()) return;
  refreshing = true;
  try {
    await refreshHistory(symbols);
    for (const sym of symbols) {
      engine.reload(sym);
      dash.broadcast({ type: 'row', row: engine.row(sym) });
    }
    dash.broadcast({ type: 'curves' });
  } catch (err) {
    log(`history refresh stopped: ${err.message}`);
    clearInterval(refresher);
  } finally {
    refreshing = false;
  }
}, REFRESH_MS);

const port = Number(args.port);
dash.server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use. Try: npm run dashboard -- --port ${port + 1}` : err.message);
  process.exit(1);
});
await dash.listen(port, args.lan ? '0.0.0.0' : '127.0.0.1');
log(`dashboard at http://localhost:${port}`);
if (args.lan) {
  const addrs = Object.values(networkInterfaces()).flat().filter((a) => a.family === 'IPv4' && !a.internal);
  for (const a of addrs) log(`on your network: http://${a.address}:${port}`);
}

const stop = async () => {
  clearInterval(refresher);
  clearInterval(flowSaver);
  try {
    engine.saveFlow();
  } catch {
    // nothing to save
  }
  try {
    socket.close();
  } catch {
    // already closed
  }
  await dash.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
