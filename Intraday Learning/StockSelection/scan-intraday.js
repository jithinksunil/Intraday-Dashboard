#!/usr/bin/env node
// Phase 2 (Stock Selection Engine) scanner on the Fyers API.
//
// Implements the selection rules from ../Strategy:
//   gates   : average traded value, ATR%, time-matched RVOL, bid-ask spread % (when live)
//   ranking : RVOL, relative ATR, relative strength vs Nifty, spread quality
//   context : gap %, change from open, relative strength vs sector peers, order-book depth
//
// Uses the repo's Fyers login (.env + .secrets/fyers-token.json, refreshed by `npm run login`).
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CandleStore } from '../../src/lib/candleStore.js';
import { loadEnv, requireEnv } from '../../src/lib/env.js';
import { FatalHistoryError, RateLimiter, syncSymbol } from '../../src/lib/history.js';
import { loadToken, TOKEN_PATH } from '../../src/lib/token.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const UNIVERSE_URL = 'https://www.niftyindices.com/IndexConstituent/ind_nifty100list.csv';
const BENCHMARK = 'NSE:NIFTY50-INDEX';
const DAY = 86400;
const OPEN_MIN = 555; // 09:15 IST
const CLOSE_MIN = 930; // 15:30 IST

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const median = values => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const finite = value => typeof value === 'number' && Number.isFinite(value);
export const istDate = seconds => new Date((seconds + 19800) * 1000).toISOString().slice(0, 10);
const istMinute = seconds => { const d = new Date((seconds + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const epoch = (date, time) => Date.parse(`${date}T${time}:00+05:30`) / 1000;
const hhmm = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const toMinute = text => { const [h, m] = text.split(':').map(Number); return h * 60 + m; };
const round = (value, digits = 4) => finite(value) ? Number(value.toFixed(digits)) : null;

export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (c === '\n') { if (row.some(Boolean)) rows.push(row); row = []; }
    } else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

/** Nifty CSV symbol + series -> Fyers symbol, e.g. ("SBIN", "EQ") -> "NSE:SBIN-EQ". */
export const fyersSymbol = (symbol, series = 'EQ') => `NSE:${symbol}-${series || 'EQ'}`;

/** Stored Fyers candles ({t,o,h,l,c,v}) -> bars with IST date and minute-of-day. */
export const toBars = candles => candles.map(k => ({
  timestamp: k.t, date: istDate(k.t), minute: istMinute(k.t), open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v,
}));

function validBar(b) {
  const tolerance = Math.max(b.high, b.open, b.close) * 1e-7;
  return ['open', 'high', 'low', 'close'].every(k => finite(b[k]) && b[k] > 0)
    && finite(b.volume) && b.volume >= 0 && b.high >= b.low
    && b.high + tolerance >= Math.max(b.open, b.close) && b.low - tolerance <= Math.min(b.open, b.close);
}

export function wilderAtr(bars, period = 14) {
  if (bars.length < period + 1 || bars.some(b => !validBar(b))) throw new Error('Invalid or insufficient daily ATR history');
  const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low,
    Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
  let atr = mean(tr.slice(0, period));
  for (const value of tr.slice(period)) atr = ((period - 1) * atr + value) / period;
  return atr;
}

// Session totals from 09:15 up to (not including) the cutoff. All expected 5-minute bars must
// be present; missing volume is never zero-filled.
export function sessionVolume(bars, date, cutoffMinute) {
  const rows = bars.filter(b => b.date === date && b.minute >= OPEN_MIN && b.minute < cutoffMinute);
  const map = new Map(rows.map(b => [b.minute, b]));
  for (let minute = OPEN_MIN; minute < cutoffMinute; minute += 5) {
    const b = map.get(minute);
    if (!b || !validBar(b)) throw new Error(`Incomplete 5-minute data: ${date} at ${hhmm(minute)}`);
  }
  return {
    volume: rows.reduce((total, b) => total + b.volume, 0), open: rows[0].open, close: rows.at(-1).close,
    high: Math.max(...rows.map(b => b.high)), low: Math.min(...rows.map(b => b.low)),
  };
}

// Special sessions (e.g. the one-hour Muhurat session) carry a fraction of normal volume and
// would distort volume/range baselines, so they are left out of them.
export function normalSessions(bars) {
  const typical = median(bars.map(b => b.volume));
  return bars.filter(b => b.volume > 0 && b.volume >= 0.2 * typical);
}

// True range of a (partial) session, including the gap from the previous close.
const sessionRange = (s, previousClose) => Math.max(s.high, previousClose) - Math.min(s.low, previousClose);

// ---- Interpretation bands from the strategy notes ----
export const rvolBand = v => v >= 5 ? 'extreme' : v >= 3 ? 'excellent' : v >= 2 ? 'very good' : v >= 1.5 ? 'good' : v >= 1 ? 'moderate' : 'below normal';
export const relativeAtrBand = v => v > 3 ? 'extreme' : v >= 2 ? 'very high' : v >= 1.5 ? 'high' : v >= 1.2 ? 'elevated' : v >= 0.8 ? 'normal' : v >= 0.5 ? 'below normal' : 'very low';
export const spreadBand = v => v == null ? 'unverified' : v <= 0.05 ? 'excellent' : v <= 0.10 ? 'very good' : 'wide';

/** Spread % = (Ask - Bid) / mid x 100. Null unless both sides are quoted. */
export function spreadPct(bid, ask) {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  return (ask - bid) / ((ask + bid) / 2) * 100;
}

/** Fyers depth payload for one symbol -> displayed liquidity summary. Null when the book is empty. */
export function depthSummary(d) {
  const bids = (d?.bids ?? []).filter(x => x.price > 0 && x.volume > 0);
  const asks = (d?.ask ?? []).filter(x => x.price > 0 && x.volume > 0);
  if (!bids.length || !asks.length) return null;
  const value = levels => levels.reduce((total, x) => total + x.price * x.volume, 0);
  const buy = d.totalbuyqty, sell = d.totalsellqty;
  return {
    spreadPct: spreadPct(bids[0].price, asks[0].price),
    top5BidValueLakh: value(bids) / 1e5, top5AskValueLakh: value(asks) / 1e5,
    totalBuyQty: buy, totalSellQty: sell,
    imbalance: buy + sell > 0 ? (buy - sell) / (buy + sell) : null,
  };
}

/**
 * Selection metrics for one stock. `daily` holds completed daily bars, `intraday` 5-minute bars.
 * A 15:30 cutoff with the session's daily bar present compares full days; any other case
 * compares 09:15-to-cutoff against the same window on prior sessions (time-matched).
 * Baselines never include the scan session.
 */
export function calculate(daily, intraday, session, cutoff = '15:30', now = Date.now() / 1000, { rvolDays = 10, baselineDays = 20 } = {}) {
  if (epoch(session, cutoff) > now) throw new Error('Requested observation is in the future');
  const past = daily.filter(b => b.date < session);
  if (past.length < 30) throw new Error('Need at least 30 prior daily observations');
  const window = past.slice(-(baselineDays + 5));
  if (window.some(b => !validBar(b))) throw new Error('Invalid prior daily OHLCV/volume');
  const normal = normalSessions(window);
  const previous = normal.slice(-baselineDays);
  if (previous.length < baselineDays) throw new Error('Not enough normal prior sessions for baselines');
  const previousClose = past.at(-1).close;
  const closeBefore = new Map(past.slice(1).map((b, i) => [b.date, past[i].close]));
  const atrPct = wilderAtr(past) / previousClose * 100;
  // Fyers candles carry volume, not rupee turnover, so traded value is close x volume.
  const averageTurnoverCrore = mean(previous.map(b => b.close * b.volume)) / 1e7;

  const end = toMinute(cutoff);
  const dayBar = cutoff === '15:30' ? daily.find(b => b.date === session) : null;
  let observed, history; // history: newest first, { date, volume, range }
  if (dayBar) {
    if (!validBar(dayBar) || dayBar.volume === 0) throw new Error('Missing target session daily data');
    observed = dayBar;
    history = [...previous].reverse().map(b => ({ date: b.date, volume: b.volume, range: sessionRange(b, closeBefore.get(b.date)) }));
  } else {
    if (cutoff === '15:30' && !intraday.some(b => b.date === session)) throw new Error('Missing target session daily data');
    observed = sessionVolume(intraday, session, end);
    history = [];
    for (const b of [...normal].reverse()) {
      if (history.length === baselineDays) break;
      try {
        const s = sessionVolume(intraday, b.date, end);
        history.push({ date: b.date, volume: s.volume, range: sessionRange(s, closeBefore.get(b.date)) });
      } catch { /* session without complete 5-minute data: left out of the baseline */ }
    }
    if (history.length < rvolDays) throw new Error(`Only ${history.length} prior sessions have complete 5-minute data to ${cutoff}; need ${rvolDays}`);
  }
  const volumeHistory = history.slice(0, rvolDays);
  const baselineVolume = mean(volumeHistory.map(h => h.volume));
  const baselineRange = mean(history.map(h => h.range));
  if (!(baselineVolume > 0) || !(baselineRange > 0)) throw new Error('Invalid historical baseline');
  return {
    price: observed.close, previousClose, averageTurnoverCrore, atrPct,
    rvol: observed.volume / baselineVolume, observedVolume: observed.volume, baselineVolume,
    relativeAtr: sessionRange(observed, previousClose) / baselineRange,
    gapPct: (observed.open / previousClose - 1) * 100,
    changeFromOpenPct: (observed.close / observed.open - 1) * 100,
    changeFromPreviousClosePct: (observed.close / previousClose - 1) * 100,
    rvolSessions: volumeHistory.map(h => h.date).reverse(), relativeAtrSessions: history.length,
    comparison: dayBar ? 'full-day' : `09:15-${cutoff} time-matched`,
  };
}

/** Benchmark move for the same observation window: % change from the previous close. */
export function benchmarkChange(daily, intraday, session, cutoff = '15:30') {
  const previousClose = daily.filter(b => b.date < session).at(-1)?.close;
  const dayBar = cutoff === '15:30' ? daily.find(b => b.date === session) : null;
  const end = toMinute(cutoff);
  const price = dayBar ? dayBar.close : intraday.filter(b => b.date === session && b.minute < end).at(-1)?.close;
  if (!(previousClose > 0) || !(price > 0)) throw new Error('Benchmark history does not cover the requested session');
  return (price / previousClose - 1) * 100;
}

/** Adds relative strength vs the benchmark and vs same-sector peers (median of the other stocks). */
export function addRelativeStrength(rows, benchmarkChangePct) {
  for (const row of rows) {
    const peers = rows.filter(r => r !== row && r.sector === row.sector).map(r => r.changeFromPreviousClosePct);
    row.rsVsNiftyPct = row.changeFromPreviousClosePct - benchmarkChangePct;
    row.rsVsSectorPct = peers.length >= 2 ? row.changeFromPreviousClosePct - median(peers) : null;
    row.sectorPeers = peers.length;
  }
  return rows;
}

/** Applies the gates. Unknown spread never rejects; it leaves the candidate unverified. */
export function gate(row, config) {
  const reasons = [];
  if (row.averageTurnoverCrore < config.minTurnoverCrore) reasons.push('turnover_below_threshold');
  if (row.atrPct < config.minAtrPct) reasons.push('atr_below_threshold');
  if (row.rvol < config.minRvol) reasons.push('rvol_below_threshold');
  if (row.spreadPct != null && row.spreadPct > config.maxSpreadPct) reasons.push('spread_above_threshold');
  return reasons;
}

/** 0-100 ranking score. Weights are unvalidated starting values, kept simple and visible. */
export function score(row) {
  const rvol = Math.min(row.rvol, 5) / 5 * 40;
  const ra = row.relativeAtr;
  const volatility = ra >= 1.2 && ra <= 2 ? 20 : (ra >= 0.8 && ra < 1.2) || (ra > 2 && ra <= 3) ? 10 : 0;
  const strength = Math.min(Math.abs(row.rsVsNiftyPct), 3) / 3 * 25;
  const spread = row.spreadPct == null ? 0 : row.spreadPct <= 0.05 ? 15 : row.spreadPct <= 0.10 ? 10 : 0;
  return rvol + volatility + strength + spread;
}

/** Which side the session's evidence favours; a watchlist hint, not an entry signal. */
export function bias(row) {
  const signs = [row.changeFromPreviousClosePct, row.changeFromOpenPct, row.rsVsNiftyPct].map(Math.sign);
  return signs.every(s => s > 0) ? 'long' : signs.every(s => s < 0) ? 'short' : 'mixed';
}

async function loadUniverse(out) {
  const cached = join(out, 'nifty100.csv');
  let csv, source = UNIVERSE_URL;
  try {
    const response = await fetch(UNIVERSE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    csv = await response.text();
    await writeFile(cached, csv);
  } catch (error) {
    csv = await readFile(cached, 'utf8').catch(() => { throw new Error(`Could not download the Nifty 100 list (${error.message}) and no cached copy exists`); });
    source = `${cached} (cached copy; download failed: ${error.message})`;
  }
  const [headers, ...records] = parseCsv(csv);
  const columns = ['Company Name', 'Industry', 'Symbol', 'Series'].map(name => headers.indexOf(name));
  if (columns.slice(0, 3).some(i => i < 0)) throw new Error('Unexpected Nifty 100 CSV schema');
  const universe = records.map(row => ({ company: row[columns[0]], sector: row[columns[1]], symbol: row[columns[2]],
    fyers: fyersSymbol(row[columns[2]], columns[3] < 0 ? 'EQ' : row[columns[3]]) }));
  if (universe.length < 90 || universe.length > 110 || new Set(universe.map(s => s.symbol)).size !== universe.length) throw new Error('Unexpected Nifty 100 constituents; inspect CSV');
  return { universe, source };
}

const HELP = `node scan-intraday.js [--date YYYY-MM-DD] [--at HH:MM] [--min-turnover 20] [--min-atr 1] [--min-rvol 1.5]
                         [--max-spread 0.10] [--rvol-days 10] [--top 10] [--out scan-results] [--refresh] [--completed]
No arguments: during market hours (from 09:30 IST) scans today up to the last completed 5-minute bar;
otherwise scans the latest completed session. --completed always scans the latest completed session.
--at is a 5-minute boundary between 09:30 and 15:30 IST.
Spread and order-book depth are only checked while the market is open. Needs a valid Fyers token: npm run login.`;

/** `shared.limiter` lets a caller that makes its own Fyers requests (the dashboard) pace them together with the scan. */
export async function main(args = process.argv.slice(2), shared = {}) {
  const { values } = parseArgs({ args, options: {
    date: { type: 'string' }, at: { type: 'string' },
    'min-turnover': { type: 'string', default: '20' }, 'min-atr': { type: 'string', default: '1' },
    'min-rvol': { type: 'string', default: '1.5' }, 'max-spread': { type: 'string', default: '0.10' },
    'rvol-days': { type: 'string', default: '10' }, top: { type: 'string', default: '10' },
    'per-minute': { type: 'string', default: '40' },
    out: { type: 'string', default: join(HERE, 'scan-results') }, refresh: { type: 'boolean' }, completed: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(HELP); return; }
  const config = { minTurnoverCrore: Number(values['min-turnover']), minAtrPct: Number(values['min-atr']), minRvol: Number(values['min-rvol']),
    maxSpreadPct: Number(values['max-spread']), rvolDays: Number(values['rvol-days']), baselineDays: 20, top: Number(values.top) };
  const perMinute = Number(values['per-minute']);
  if ([config.minTurnoverCrore, config.minAtrPct, config.minRvol, config.maxSpreadPct, config.rvolDays, config.top, perMinute].some(n => !finite(n) || n <= 0)
      || !Number.isInteger(config.top) || !Number.isInteger(config.rvolDays) || config.rvolDays > 20) throw new Error('Thresholds must be positive numbers; top and rvol-days must be integers (rvol-days at most 20)');
  if (values.at !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(values.at)) throw new Error('Use --at HH:MM');
    const m = toMinute(values.at);
    if (Number(values.at.slice(3)) >= 60 || m < 570 || m > CLOSE_MIN || m % 5) throw new Error('--at must be a 5-minute boundary between 09:30 and 15:30 IST');
  }
  if (values.date && (!/^\d{4}-\d{2}-\d{2}$/.test(values.date) || !finite(epoch(values.date, '00:00')) || istDate(epoch(values.date, '00:00')) !== values.date)) throw new Error('Invalid --date');

  // ---- Fyers session ----
  loadEnv(join(ROOT, '.env'));
  const { FYERS_APP_ID: appId } = requireEnv('FYERS_APP_ID');
  const accessToken = loadToken(appId, { path: join(ROOT, TOKEN_PATH) });
  const { default: fyers } = await import('fyers-api-v3');
  const model = new fyers.fyersModel({ enableLogging: false }); // logging off: the SDK would write the token to a log file
  model.setAppId(appId);
  model.setAccessToken(accessToken);

  const out = values.out;
  const cache = join(out, 'cache', 'candles');
  if (values.refresh) await rm(cache, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const store = new CandleStore(cache);
  const limiter = shared.limiter ?? new RateLimiter({ perMinute, perSecond: 3 });
  // Fyers counts requests per account, not per run: carry the last minute's calls over from the
  // previous run so back-to-back scans cannot exceed the per-minute limit together.
  const limiterFile = join(out, 'cache', 'recent-requests.json');
  limiter.calls = [...await readFile(limiterFile, 'utf8').then(JSON.parse).then(v => v.filter(finite)).catch(() => []), ...limiter.calls].sort((a, b) => a - b);
  const saveLimiter = () => { try { mkdirSync(dirname(limiterFile), { recursive: true }); writeFileSync(limiterFile, JSON.stringify(limiter.calls)); } catch { /* best effort */ } };
  process.once('exit', saveLimiter);
  const state = { requests: 0, rateLimitHits: 0 };
  const now = Math.floor(Date.now() / 1000);
  const today = istDate(now), nowMinute = istMinute(now);

  // Fetches only what the cache lacks. `covered(lastBar)` says whether the cache already reaches far enough.
  async function candles(symbol, res, lookbackDays, covered) {
    const stored = store.read(symbol, res);
    if (stored.length && covered(stored.at(-1))) return toBars(stored);
    const problems = [];
    await syncSymbol({ getHistory: p => model.getHistory(p), store, symbol, res, fromSec: now - lookbackDays * DAY, nowSec: now, limiter, state, log: m => problems.push(m) });
    if (problems.some(m => m.startsWith('skipped'))) throw new Error(problems.at(-1));
    return toBars(store.read(symbol, res));
  }

  const { universe, source: universeSource } = await loadUniverse(out);

  // ---- Which session and cutoff ----
  const benchDaily = await candles(BENCHMARK, 'D', 150, () => false);
  const bench5 = await candles(BENCHMARK, '5m', 50, () => false);
  const todayMinutes = bench5.filter(b => b.date === today).map(b => b.minute);
  let session, cutoff;
  if (values.completed && (values.date || values.at)) throw new Error('--completed cannot be combined with --date or --at');
  if (values.completed) { session = benchDaily.at(-1)?.date; cutoff = '15:30'; }
  else if (values.date) { session = values.date; cutoff = values.at ?? '15:30'; }
  else if (benchDaily.some(b => b.date === today) && !values.at) { session = today; cutoff = '15:30'; }
  else if (todayMinutes.length) {
    const available = Math.min(CLOSE_MIN, todayMinutes.at(-1) + 5);
    cutoff = values.at ?? hhmm(available);
    session = today;
    if (toMinute(cutoff) > available) throw new Error(`--at ${cutoff} has not completed yet; latest completed 5-minute bar ends ${hhmm(available)} IST`);
    if (toMinute(cutoff) < 570) { session = undefined; }
  }
  if (!session) {
    if (values.at) throw new Error('No trading data for today yet; pass --date with --at for a past session');
    session = benchDaily.at(-1)?.date; cutoff = '15:30';
  }
  const dailyMode = cutoff === '15:30' && benchDaily.some(b => b.date === session);
  const end = toMinute(cutoff);
  if (!dailyMode) {
    if (session > today || epoch(session, cutoff) > now) throw new Error('Requested session/cutoff is in the future');
    try { sessionVolume(bench5, session, end); } catch { throw new Error(`No complete Nifty 50 5-minute data for ${session} through ${cutoff} IST (holiday, weekend, or older than the cached history; try --refresh)`); }
  }
  const benchmarkChangePct = benchmarkChange(benchDaily, bench5, session, cutoff);
  const lastDailyNeeded = dailyMode ? session : benchDaily.filter(b => b.date < session).at(-1)?.date;
  const live = session === today && nowMinute >= OPEN_MIN && nowMinute < CLOSE_MIN;
  console.log(`Scanning ${universe.length} Nifty 100 stocks for ${session} through ${cutoff} IST (${dailyMode ? 'completed session' : 'time-matched intraday'}${live ? ', market open' : ''}). Nifty 50: ${benchmarkChangePct.toFixed(2)}%`);

  // ---- Per-stock metrics ----
  const rows = [], errors = []; let done = 0;
  for (const stock of universe) {
    try {
      const daily = await candles(stock.fyers, 'D', 150, last => istDate(last.t) >= lastDailyNeeded);
      const intraday = dailyMode ? [] : await candles(stock.fyers, '5m', 50, last => last.t >= epoch(session, cutoff) - 300);
      rows.push({ ...stock, ...calculate(daily, intraday, session, cutoff, now, config), spreadPct: null, bid: null, ask: null, depth: null });
    } catch (error) {
      if (error instanceof FatalHistoryError) throw error;
      errors.push({ ...stock, error: error.message });
    }
    if (++done % 10 === 0) console.log(`Processed ${done}/${universe.length}; data errors: ${errors.length}; Fyers requests: ${state.requests}`);
  }
  addRelativeStrength(rows, benchmarkChangePct);

  // ---- Live spread (two requests cover the universe) ----
  const liveNotes = [];
  if (live && rows.length) {
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      try {
        await limiter.take(); state.requests++;
        const response = await model.getQuotes(batch.map(r => r.fyers));
        const bySymbol = new Map((response?.d ?? []).map(q => [q.n, q.v]));
        for (const row of batch) {
          const q = bySymbol.get(row.fyers);
          if (!q) continue;
          row.bid = q.bid || null; row.ask = q.ask || null; row.spreadPct = spreadPct(q.bid, q.ask);
        }
      } catch (error) { liveNotes.push(`Quote request failed (${error?.message ?? error?.code ?? 'unknown'}); spread left unverified for ${batch.length} stocks.`); }
    }
  }

  for (const row of rows) {
    row.rejectionReasons = gate(row, config);
    row.matches = row.rejectionReasons.length === 0;
    row.score = score(row); row.bias = bias(row);
    row.rvolBand = rvolBand(row.rvol); row.relativeAtrBand = relativeAtrBand(row.relativeAtr); row.spreadBand = spreadBand(row.spreadPct);
  }
  rows.sort((a, b) => b.matches - a.matches || b.score - a.score || b.rvol - a.rvol || a.symbol.localeCompare(b.symbol));
  const matches = rows.filter(row => row.matches);

  // ---- Live order-book depth for the shortlist ----
  if (live) {
    for (const row of matches.slice(0, config.top)) {
      try {
        await limiter.take(); state.requests++;
        const response = await model.getMarketDepth({ symbol: [row.fyers], ohlcv_flag: 1 });
        row.depth = depthSummary(response?.d?.[row.fyers]);
      } catch (error) { liveNotes.push(`Depth request failed for ${row.symbol} (${error?.message ?? error?.code ?? 'unknown'}).`); }
    }
  }
  rows.forEach(row => { row.verification = row.spreadPct == null ? 'PROVISIONAL: spread and depth not checked' : row.depth ? 'spread and depth checked at scan time' : 'spread checked at scan time; depth not checked'; });

  const report = {
    fetchedAt: new Date().toISOString(), session, cutoffIST: cutoff,
    observationType: dailyMode ? 'completed-session' : 'time-matched-intraday', marketOpenAtScan: live,
    sessionAgeCalendarDays: Math.floor((epoch(today, '00:00') - epoch(session, '00:00')) / DAY),
    dataSource: 'Fyers API v3 (history, quotes, depth)', universeSource, benchmark: BENCHMARK, benchmarkChangePct,
    config, universeCount: universe.length, evaluatedCount: rows.length, matchedCount: matches.length,
    spreadVerifiedCount: matches.filter(r => r.spreadPct != null).length, fyersRequests: state.requests,
    limitations: [
      live ? 'Spread and depth are single snapshots taken at scan time; displayed orders can be cancelled or changed.'
        : 'Market was closed at scan time, so bid-ask spread and order-book depth are not checked. Every match is provisional on that point.',
      'Average traded value is mean(close x volume) over the 20 prior normal sessions, not exchange-reported turnover.',
      `RVOL compares volume with the previous ${config.rvolDays} sessions over the same window (${dailyMode ? 'full day' : `09:15-${cutoff}`}).`,
      'Relative ATR here is this session\'s true range for that window divided by the average of the same over up to 20 prior sessions.',
      'Sector relative strength uses the median of same-industry Nifty 100 peers, not a sector index.',
      'Sessions with under 20% of typical volume (e.g. Muhurat trading) are left out of baselines.',
      'Volume profile, news/catalysts and broker intraday eligibility are not checked.',
      'Past dates use today\'s constituents. Thresholds and score weights are untested starting values, not a return forecast.',
      ...liveNotes,
    ], matches, rows, errors,
  };
  const files = { 'scan.json': JSON.stringify(report, null, 2) + '\n', 'scan.csv': toCsv(rows), 'result.md': toMarkdown(report) };
  const runDirectory = join(out, 'runs', `${session}_${cutoff.replace(':', '')}`);
  await mkdir(runDirectory, { recursive: true });
  for (const [name, body] of Object.entries(files)) { await writeFile(join(out, name), body); await writeFile(join(runDirectory, name), body); }

  console.table(matches.slice(0, config.top).map(row => ({ Symbol: row.symbol, Score: round(row.score, 1), Bias: row.bias, 'Price ₹': round(row.price, 2),
    'Turnover ₹Cr': round(row.averageTurnoverCrore, 1), 'ATR %': round(row.atrPct, 2), RVOL: round(row.rvol, 2), 'Rel ATR': round(row.relativeAtr, 2),
    'RS vs Nifty %': round(row.rsVsNiftyPct, 2), 'Spread %': round(row.spreadPct, 3) })));
  console.log(`${matches.length} matches of ${rows.length} evaluated; ${errors.length} data errors; ${state.requests} Fyers requests.`);
  console.log(`Saved: ${join(out, 'result.md')} (also scan.json, scan.csv; copy kept in ${runDirectory})`);
  if (errors.length) console.log('Data errors are listed individually in scan.json.');
  if (report.sessionAgeCalendarDays > 4) console.log('WARNING: the scanned session is more than 4 calendar days old.');
  if (!rows.length) process.exitCode = 1;
  return report;
}

function toCsv(rows) {
  const columns = ['symbol', 'company', 'sector', 'matches', 'score', 'bias', 'price', 'averageTurnoverCrore', 'atrPct', 'rvol', 'rvolBand', 'relativeAtr', 'relativeAtrBand',
    'gapPct', 'changeFromOpenPct', 'changeFromPreviousClosePct', 'rsVsNiftyPct', 'rsVsSectorPct', 'spreadPct', 'spreadBand', 'rejectionReasons', 'verification'];
  const cell = value => `"${String(Array.isArray(value) ? value.join(' ') : value ?? '').replaceAll('"', '""')}"`;
  return [columns.join(','), ...rows.map(row => columns.map(key => cell(typeof row[key] === 'number' ? round(row[key]) : row[key])).join(','))].join('\n') + '\n';
}

function toMarkdown(r) {
  const n = (value, digits = 2) => finite(value) ? value.toFixed(digits) : '—';
  const signed = value => finite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}` : '—';
  const c = r.config;
  const lines = [
    '# Intraday Stock Selection — Scan Results', '',
    `**Session:** ${r.session}, through ${r.cutoffIST} IST (${r.observationType === 'completed-session' ? 'completed session' : 'time-matched intraday'}).`,
    `**Scanned at:** ${new Date(r.fetchedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST, market ${r.marketOpenAtScan ? 'open' : 'closed'}.`,
    `**Source:** ${r.dataSource}; Nifty 100 constituents.`,
    `**Nifty 50 over the same window:** ${signed(r.benchmarkChangePct)}%.`, '',
    `Evaluated **${r.evaluatedCount}** of ${r.universeCount} stocks: **${r.matchedCount} matches**, ${r.spreadVerifiedCount} with spread checked, ${r.errors.length} data errors.`, '',
    r.marketOpenAtScan ? 'This is a watchlist for entry analysis, not a set of trade signals.'
      : 'This describes the stated session. Spread and depth were not checked because the market was closed, so re-check them in live trading before using a candidate.', '',
    '## Filters', '',
    `- Average traded value (20 prior sessions): at least ₹${c.minTurnoverCrore} crore.`,
    `- Daily ATR(14) as % of previous close: at least ${c.minAtrPct}%.`,
    `- RVOL vs the previous ${c.rvolDays} sessions over the same window: at least ${c.minRvol}×.`,
    `- Bid-ask spread: at most ${c.maxSpreadPct}% (only applied when the market is open).`, '',
    'Ranked by score (0–100): RVOL up to 40, relative ATR in the 1.2–2 range 20, relative strength vs Nifty up to 25, tight spread up to 15.', '',
    '## Matches', '',
  ];
  if (!r.matches.length) lines.push('No stock passed every filter.', '');
  else {
    lines.push('| Rank | Symbol | Sector | Score | Bias | Price ₹ | Traded value ₹Cr | ATR% | RVOL | Rel. ATR | Gap % | From open % | Day % | RS vs Nifty | RS vs sector | Spread % |',
      '|---:|---|---|---:|---|---:|---:|---:|---|---|---:|---:|---:|---:|---:|---|');
    r.matches.forEach((row, i) => lines.push(`| ${i + 1} | ${row.symbol} | ${row.sector} | ${n(row.score, 1)} | ${row.bias} | ${n(row.price)} | ${n(row.averageTurnoverCrore, 1)} | ${n(row.atrPct)} | ${n(row.rvol)}× ${row.rvolBand} | ${n(row.relativeAtr)} ${row.relativeAtrBand} | ${signed(row.gapPct)} | ${signed(row.changeFromOpenPct)} | ${signed(row.changeFromPreviousClosePct)} | ${signed(row.rsVsNiftyPct)} | ${signed(row.rsVsSectorPct)} | ${row.spreadPct == null ? 'not checked' : `${n(row.spreadPct, 3)} ${row.spreadBand}`} |`));
    lines.push('', 'Bias is *long* when the day change, change from open and strength vs Nifty are all positive, *short* when all are negative, otherwise *mixed*.', '');
  }
  const withDepth = r.matches.filter(row => row.depth);
  if (withDepth.length) {
    lines.push('## Order book at scan time (top matches)', '', '| Symbol | Bid ₹ | Ask ₹ | Top-5 bid value ₹L | Top-5 ask value ₹L | Total buy qty | Total sell qty | Imbalance |', '|---|---:|---:|---:|---:|---:|---:|---:|');
    withDepth.forEach(row => lines.push(`| ${row.symbol} | ${n(row.bid)} | ${n(row.ask)} | ${n(row.depth.top5BidValueLakh, 1)} | ${n(row.depth.top5AskValueLakh, 1)} | ${row.depth.totalBuyQty} | ${row.depth.totalSellQty} | ${signed(row.depth.imbalance)} |`));
    lines.push('');
  }
  const near = r.rows.filter(row => !row.matches && row.rejectionReasons.length === 1).slice(0, 10);
  if (near.length) {
    lines.push('## Near misses (failed one filter)', '', '| Symbol | Failed | RVOL | ATR% | Traded value ₹Cr | Day % | Spread % |', '|---|---|---:|---:|---:|---:|---:|');
    near.forEach(row => lines.push(`| ${row.symbol} | ${row.rejectionReasons[0].replaceAll('_', ' ')} | ${n(row.rvol)} | ${n(row.atrPct)} | ${n(row.averageTurnoverCrore, 1)} | ${signed(row.changeFromPreviousClosePct)} | ${n(row.spreadPct, 3)} |`));
    lines.push('');
  }
  if (r.errors.length) lines.push('## Data errors', '', ...r.errors.map(e => `- ${e.symbol}: ${e.error}`), '');
  lines.push('## Limitations', '', ...r.limitations.map(text => `- ${text}`), '');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Scan failed: ${error.message}`); process.exitCode = 1; });
}
