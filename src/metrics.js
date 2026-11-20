// Computes the Phase 1-3 metrics from stored candles plus the latest recording, prints them,
// and writes the full result to data/metrics/latest.json.
//
// Usage: npm run metrics [-- --tf 5] [--watchlist config/watchlist.json] [--data data]
//
// Indicators use completed candles only, so values are "as of the last finished candle".
// Periods and regime thresholds are conventional placeholders, to be tested, not tuned settings.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CandleStore, istText } from './lib/candleStore.js';
import * as ind from './lib/indicators.js';
import { lastBySymbol, latestDay } from './lib/records.js';
import { inMarketHours } from './lib/time.js';
import { loadWatchlist } from './lib/watchlist.js';

const { values: args } = parseArgs({
  options: {
    tf: { type: 'string', default: '5' },
    watchlist: { type: 'string', default: 'config/watchlist.json' },
    sectors: { type: 'string', default: 'config/sectors.json' },
    data: { type: 'string', default: 'data' },
  },
});
const TF = Number(args.tf);
if (!Number.isInteger(TF) || TF < 1) {
  console.error('--tf must be a whole number of minutes, e.g. 5');
  process.exit(1);
}
const BARS = 1500; // history fed to the indicators; ample warm-up for every period used here

const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const { last } = ind;
const isIndex = (s) => s.endsWith('-INDEX');

let watch;
let sectors;
try {
  watch = loadWatchlist(args.watchlist);
  sectors = JSON.parse(readFileSync(args.sectors, 'utf8'));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const symbols = [...new Set([...watch.quotes, ...watch.depth5])];
const store = new CandleStore(join(args.data, 'candles'));

// ---------- load candles ----------
const series = new Map();
const missing = [];
for (const sym of symbols) {
  const m1 = store.read(sym, '1m');
  if (m1.length < 500) {
    missing.push(sym);
    continue;
  }
  const recent = m1.slice(-BARS * TF - 400);
  series.set(sym, { m1, tf: ind.resample(recent, TF).slice(-BARS), daily: ind.toDaily(m1), today: last(ind.sessions(recent)) });
}
if (!series.size) {
  console.error('No 1-minute candles found. Run: npm run history');
  process.exit(1);
}

// ---------- latest recorded quotes and depth ----------
const recDay = latestDay(args.data);
const quotes = recDay ? await lastBySymbol(args.data, recDay, 'quotes') : new Map();
const depth = recDay ? await lastBySymbol(args.data, recDay, 'depth5') : new Map();

// ---------- per-symbol metrics ----------
function trendMetrics(s) {
  const closes = s.tf.map((k) => k.c);
  const e20 = ind.ema(closes, 20);
  const a = ind.atr(s.tf, 14);
  const dx = ind.adx(s.tf, 14);
  const price = last(closes);
  return {
    price,
    atr: last(a),
    atrPct: (last(a) / price) * 100,
    relAtr: ind.relativeAtrByTime(s.tf, a, 20)?.ratio ?? null,
    ema20: last(e20),
    emaSlopePct: last(ind.pctChange(e20, 5)),
    roc10: last(ind.roc(closes, 10)),
    rsi14: last(ind.rsi(closes, 14)),
    adx14: last(dx.adx),
    plusDI: last(dx.plusDI),
    minusDI: last(dx.minusDI),
  };
}

function regime(t) {
  const trend = t.adx14 >= 25 ? (t.plusDI > t.minusDI ? 'trending up' : 'trending down') : 'ranging';
  const vol = t.relAtr >= 1.3 ? 'high volatility' : t.relAtr <= 0.7 ? 'low volatility' : 'normal volatility';
  return `${trend}, ${vol}`;
}

const dayReturn = (s) => {
  const prev = s.daily.at(-2);
  return prev ? ((last(s.daily).c - prev.c) / prev.c) * 100 : null;
};
const dailyReturns = (s, n = 60) => s.daily.slice(-n - 1).map((k, i, a) => (i ? (k.c - a[i - 1].c) / a[i - 1].c : null)).slice(1);

const bench = series.get(sectors.benchmark);
const out = { asOf: null, timeframeMin: TF, market: {}, stocks: {}, notes: [] };

// Phase 1: market
for (const sym of symbols.filter(isIndex)) {
  const s = series.get(sym);
  if (!s) continue;
  const t = trendMetrics(s);
  out.market[sym] = {
    ...t,
    dayChangePct: dayReturn(s),
    rsVsBenchmarkPct: bench && sym !== sectors.benchmark && sym !== sectors.vix ? dayReturn(s) - dayReturn(bench) : null,
    regime: sym === sectors.vix ? null : regime(t),
    lastCandle: istText(last(s.tf).t),
  };
}
if (bench) out.asOf = `${istText(last(bench.tf).t)} IST`;

// Phases 2 and 3: stocks
for (const sym of symbols.filter((s) => !isIndex(s))) {
  const s = series.get(sym);
  if (!s) continue;
  const t = trendMetrics(s);
  const closes = s.tf.map((k) => k.c);
  const mc = ind.macd(closes);
  const bb = ind.bollinger(closes, 20, 2);
  const sessVwap = last(ind.vwap(s.today));
  const prevDay = s.daily.at(-2);
  const piv = prevDay ? ind.pivots(prevDay) : null;
  const tick = Math.max(0.05, Math.round((t.price * 0.0005) / 0.05) * 0.05);
  const profile = ind.volumeProfile(s.today, tick);
  const levels = ind.nearestLevels(s.tf.slice(-300), t.price, 3);
  const sectorSym = sectors.sectorOf[sym];
  const sector = sectorSym ? series.get(sectorSym) : null;
  // Outside market hours the book is one-sided or stale, so order-book metrics are left empty.
  const live = (r) => (r && inMarketHours(r.recv) ? r : null);
  const q = live(quotes.get(sym));
  const d = live(depth.get(sym));
  const sum = (lv) => lv.reduce((a, l) => a + l[1], 0);
  const twoSided = q && q.bid > 0 && q.ask > q.bid;
  const bidQty = d ? sum(d.bids) : null;
  const askQty = d ? sum(d.asks) : null;

  out.stocks[sym] = {
    ...t,
    dayChangePct: dayReturn(s),
    // Phase 2
    rvol: ind.rvol(s.m1.slice(-375 * 25), 20),
    avgTradedValueCr: last(ind.sma(s.daily.map((k) => (k.v * (k.h + k.l + k.c)) / 3), Math.min(20, s.daily.length))) / 1e7,
    rsVsNiftyPct: bench ? dayReturn(s) - dayReturn(bench) : null,
    rsVsSectorPct: sector ? dayReturn(s) - dayReturn(sector) : null,
    corrWithNifty60d: bench ? ind.correlation(dailyReturns(s), dailyReturns(bench)) : null,
    // Phase 3
    vwap: sessVwap,
    vwapDevAtr: sessVwap ? (t.price - sessVwap) / t.atr : null,
    aboveVwap: sessVwap ? t.price > sessVwap : null,
    macd: last(mc.line),
    macdSignal: last(mc.signal),
    macdHist: last(mc.hist),
    bbUpper: last(bb.upper),
    bbLower: last(bb.lower),
    bbWidthPct: last(bb.widthPct),
    bbPctB: last(bb.pctB),
    pivot: piv?.p ?? null,
    r1: piv?.r1 ?? null,
    s1: piv?.s1 ?? null,
    support: levels.support,
    resistance: levels.resistance,
    poc: profile?.poc ?? null,
    vah: profile?.vah ?? null,
    val: profile?.val ?? null,
    chandelierLong: last(ind.chandelier(s.tf, 22, 3))?.long ?? null,
    chandelierShort: last(ind.chandelier(s.tf, 22, 3))?.short ?? null,
    // From the live recording (order book)
    spreadPct: twoSided ? ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100 : null,
    bookImbalance5: bidQty != null && bidQty + askQty > 0 ? (bidQty - askQty) / (bidQty + askQty) : null,
    bookImbalanceTotal: q && q.tbq + q.tsq > 0 ? (q.tbq - q.tsq) / (q.tbq + q.tsq) : null,
    depth5Qty: d ? { bid: bidQty, ask: askQty } : null,
    recordedAt: q ? `${istText(Math.floor(q.recv / 1000))} IST` : null,
  };
}

// Watchlist breadth (not market-wide breadth: only the stocks in the watchlist)
const stockRows = Object.values(out.stocks);
out.breadth = {
  stocks: stockRows.length,
  advancing: stockRows.filter((r) => r.dayChangePct > 0).length,
  declining: stockRows.filter((r) => r.dayChangePct < 0).length,
  aboveVwap: stockRows.filter((r) => r.aboveVwap).length,
};

if (missing.length) out.notes.push(`No candles yet for: ${missing.join(', ')} (run npm run history)`);
if (!stockRows.some((r) => r.recordedAt)) {
  out.notes.push('Spread and order-book columns are empty: no recording from market hours yet (npm run record between 09:15 and 15:30 IST)');
}

// ---------- print ----------
const table = (rows, cols) =>
  console.table(Object.fromEntries(Object.entries(rows).map(([sym, r]) => [sym.replace(/^NSE:|-EQ$|-INDEX$/g, ''), Object.fromEntries(cols.map(([name, key, d]) => [name, typeof r[key] === 'number' ? round(r[key], d ?? 2) : (r[key] ?? '')]))])));

console.log(`\nMetrics on ${TF}-minute candles, as of ${out.asOf ?? 'n/a'} (last completed candle)\n`);
console.log('PHASE 1  Market');
table(out.market, [['price', 'price'], ['day %', 'dayChangePct'], ['ATR', 'atr'], ['relATR', 'relAtr'], ['EMA slope %', 'emaSlopePct', 3], ['ROC', 'roc10'], ['RSI', 'rsi14', 1], ['ADX', 'adx14', 1], ['+DI', 'plusDI', 1], ['-DI', 'minusDI', 1], ['RS vs Nifty %', 'rsVsBenchmarkPct'], ['regime', 'regime']]);
console.log(`Watchlist breadth: ${out.breadth.advancing} up, ${out.breadth.declining} down, ${out.breadth.aboveVwap}/${out.breadth.stocks} above VWAP\n`);
console.log('PHASE 2  Stock selection');
table(out.stocks, [['price', 'price'], ['day %', 'dayChangePct'], ['RVOL', 'rvol'], ['ATR %', 'atrPct', 3], ['relATR', 'relAtr'], ['value Cr', 'avgTradedValueCr', 0], ['RS Nifty %', 'rsVsNiftyPct'], ['RS sector %', 'rsVsSectorPct'], ['corr Nifty', 'corrWithNifty60d'], ['spread %', 'spreadPct', 4], ['imb 5', 'bookImbalance5'], ['imb book', 'bookImbalanceTotal']]);
console.log('PHASE 3  Strategy and entry');
table(out.stocks, [['price', 'price'], ['EMA20', 'ema20'], ['slope %', 'emaSlopePct', 3], ['RSI', 'rsi14', 1], ['ROC', 'roc10'], ['MACD hist', 'macdHist', 3], ['VWAP', 'vwap'], ['VWAP dev/ATR', 'vwapDevAtr'], ['BB %B', 'bbPctB'], ['BB width %', 'bbWidthPct']]);
console.log('PHASE 3  Levels (and Chandelier exit levels for Phase 6)');
table(out.stocks, [['price', 'price'], ['S1', 's1'], ['pivot', 'pivot'], ['R1', 'r1'], ['support', 'support'], ['resistance', 'resistance'], ['VAL', 'val'], ['POC', 'poc'], ['VAH', 'vah'], ['chand long', 'chandelierLong'], ['chand short', 'chandelierShort']]);
for (const n of out.notes) console.log(`note: ${n}`);

const dir = join(args.data, 'metrics');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nFull values written to ./${join(dir, 'latest.json')}`);
