#!/usr/bin/env node
// Node.js 22+, no dependencies. All candle timestamps denote interval starts.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { barsFrom, istDate, wilderAtr } from '../StockSelection/scan-intraday.js';

const DAY = 86400;
const STEP = 300;
const finite = Number.isFinite;
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const epoch = (date, time) => Date.parse(`${date}T${time}:00+05:30`) / 1000;
const iso = seconds => new Date(seconds * 1000).toISOString();
const ist = seconds => new Date((seconds + 19800) * 1000).toISOString().replace('Z', '+05:30');
const fmt = value => finite(value) ? value.toFixed(4) : 'Unavailable';
const money = value => finite(value) ? `₹${fmt(value)}` : 'Unavailable';
const percent = value => finite(value) ? `${fmt(value)}%` : 'Unavailable';

export function normalizeSymbol(value) {
  if (typeof value !== 'string') throw new Error('An NSE symbol is required');
  const symbol = value.trim().toUpperCase().replace(/^NSE:/, '').replace(/\.NS$/, '');
  if (!/^[A-Z0-9][A-Z0-9&.-]{0,29}$/.test(symbol) || symbol.includes('..')) throw new Error('Invalid NSE symbol');
  return symbol;
}

export function parseTime(value) {
  // Require seconds and an explicit offset; reject Date.parse calendar rollovers.
  const match = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/);
  const day = match ? new Date(`${match[1]}T00:00:00Z`) : null;
  if (!match || !finite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1]
      || /[+-]14:(?!00)/.test(value) || !finite(Date.parse(value))) {
    throw new Error('Use a valid ISO timestamp with timezone, e.g. 2026-11-11T14:00:00+05:30');
  }
  return Date.parse(value) / 1000;
}

function validBar(b) {
  const tolerance = Math.max(b.high, b.open, b.close) * 1e-7;
  return ['open', 'high', 'low', 'close'].every(k => finite(b[k]) && b[k] > 0)
    && finite(b.volume) && b.volume >= 0 && b.high >= b.low
    && b.high + tolerance >= Math.max(b.open, b.close)
    && b.low - tolerance <= Math.min(b.open, b.close);
}

export function emaSeries(closes, period = 20) {
  if (closes.length < period) throw new Error(`EMA(${period}) needs at least ${period} closes`);
  const result = Array(period - 1).fill(null);
  let ema = mean(closes.slice(0, period));
  result.push(ema);
  for (const close of closes.slice(period)) {
    ema += 2 / (period + 1) * (close - ema);
    result.push(ema);
  }
  return result;
}

export function rsi(closes, period = 14) {
  if (closes.length <= period) throw new Error(`RSI(${period}) needs ${period + 1} closes`);
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  let gain = mean(changes.slice(0, period).map(d => Math.max(d, 0)));
  let loss = mean(changes.slice(0, period).map(d => Math.max(-d, 0)));
  for (const change of changes.slice(period)) {
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (gain === 0 && loss === 0) return 50; // Explicit neutral convention for a flat series.
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

export function roc(closes, period = 9) {
  if (closes.length <= period) throw new Error(`ROC(${period}) needs ${period + 1} closes`);
  return (closes.at(-1) / closes.at(-1 - period) - 1) * 100;
}

export function vwap(bars) {
  const volume = bars.reduce((total, b) => total + b.volume, 0);
  if (!(volume > 0)) throw new Error('Session VWAP requires positive cumulative volume');
  return bars.reduce((total, b) => total + (b.high + b.low + b.close) / 3 * b.volume, 0) / volume;
}

export function pivotPoints(previous) {
  const { high: h, low: l, close: c } = previous;
  const p = (h + l + c) / 3;
  return { date: previous.date, high: h, low: l, close: c, P: p,
    R1: 2 * p - l, S1: 2 * p - h, R2: p + h - l, S2: p - h + l,
    R3: h + 2 * (p - l), S3: l - 2 * (h - p) };
}

export function supportResistance(bars, price, atr) {
  const swings = [];
  // Two closed candles on each side are necessary; no unconfirmed end-of-series swings.
  for (let i = 2; i < bars.length - 2; i++) {
    const b = bars[i], window = bars.slice(i - 2, i + 3);
    if (window.some(other => other.date !== b.date)) continue;
    const others = [window[0], window[1], window[3], window[4]];
    for (const [type, key, compare] of [
      ['swing high', 'high', (a, v) => a > v],
      ['swing low', 'low', (a, v) => a < v],
    ]) {
      if (others.every(other => compare(b[key], other[key]))) {
        swings.push({ type, price: b[key], time: iso(b.timestamp), confirmedAt: iso(bars[i + 2].timestamp + STEP) });
      }
    }
  }
  const tolerance = 0.2 * atr, groups = [];
  for (const swing of [...swings].sort((a, b) => a.price - b.price)) {
    const last = groups.at(-1);
    // Bound the entire cluster width, avoiding chained levels far apart.
    if (last && swing.price - last[0].price <= tolerance) last.push(swing);
    else groups.push([swing]);
  }
  const zones = groups.filter(group => group.length >= 2).map(group => {
    const low = group[0].price, high = group.at(-1).price;
    return { low, high, level: mean(group.map(s => s.price)), touches: group.length,
      role: high < price ? 'support' : low > price ? 'resistance' : 'at price',
      lastConfirmedAt: group.map(s => s.confirmedAt).sort().at(-1), swings: group };
  });
  const supports = zones.filter(z => z.role === 'support').sort((a, b) => b.high - a.high);
  const resistances = zones.filter(z => z.role === 'resistance').sort((a, b) => a.low - b.low);
  return { tolerance, minimumTouches: 2, swings, zones,
    nearestSupport: supports[0] ?? null, nearestResistance: resistances[0] ?? null };
}

export function orderBookImbalance(book, symbol, asOf, maxAgeSeconds = 60) {
  if (!book) return { status: 'unavailable', value: null,
    reason: 'No historical depth snapshot supplied. OHLCV candles do not contain bid/ask quantities.' };
  if (normalizeSymbol(book.symbol) !== normalizeSymbol(symbol)) throw new Error('Order book symbol does not match');
  const timestamp = parseTime(book.timestamp), ageSeconds = asOf - timestamp;
  if (ageSeconds < 0) throw new Error('Order book snapshot is later than the requested time');
  if (ageSeconds > maxAgeSeconds) throw new Error(`Order book snapshot is stale (${ageSeconds}s; maximum ${maxAgeSeconds}s)`);
  if (!Array.isArray(book.bids) || !Array.isArray(book.asks) || !book.bids.length || !book.asks.length) {
    throw new Error('Order book requires nonempty bids and asks arrays');
  }
  const clean = levels => {
    if (levels.some(l => !finite(l.price) || l.price <= 0 || !Number.isSafeInteger(l.quantity) || l.quantity < 0)) {
      throw new Error('Depth levels require positive prices and nonnegative integer quantities');
    }
    if (new Set(levels.map(l => l.price)).size !== levels.length) throw new Error('Duplicate depth price levels');
    return levels;
  };
  const bids = clean(book.bids).toSorted((a, b) => b.price - a.price);
  const asks = clean(book.asks).toSorted((a, b) => a.price - b.price);
  if (bids[0].price >= asks[0].price) throw new Error('Order book is locked or crossed');
  const levels = Math.min(5, bids.length, asks.length);
  const bidQuantity = bids.slice(0, levels).reduce((sum, l) => sum + l.quantity, 0);
  const askQuantity = asks.slice(0, levels).reduce((sum, l) => sum + l.quantity, 0);
  if (!Number.isSafeInteger(bidQuantity + askQuantity) || bidQuantity + askQuantity <= 0) throw new Error('Invalid total depth quantity');
  return { status: 'available', value: (bidQuantity - askQuantity) / (bidQuantity + askQuantity),
    timestamp: iso(timestamp), ageSeconds, levelsPerSide: levels, bidQuantity, askQuantity,
    source: typeof book.source === 'string' ? book.source : 'User-supplied snapshot' };
}

function chartFrom(payload, symbol, interval) {
  if (payload.chart?.error) throw new Error(payload.chart.error.description);
  const chart = payload.chart?.result?.[0];
  if (!chart || chart.meta?.symbol !== `${symbol}.NS` || chart.meta?.currency !== 'INR') {
    throw new Error(`Missing or mismatched ${interval} chart for ${symbol}.NS in INR`);
  }
  if (chart.meta.dataGranularity && chart.meta.dataGranularity !== interval) throw new Error(`Expected ${interval} chart interval`);
  return chart;
}

export function calculateIndicators({ symbol, at, intradayPayload, dailyPayload, book = null, now = Date.now() / 1000 }) {
  symbol = normalizeSymbol(symbol);
  const asOf = parseTime(at), date = istDate(asOf);
  if (asOf > now) throw new Error('Requested timestamp is in the future');
  const open = epoch(date, '09:15'), close = epoch(date, '15:30');
  const cutoff = Math.min(close, open + Math.floor((asOf - open) / STEP) * STEP);
  if (cutoff <= open) throw new Error('No completed regular-session 5-minute candle at the requested time');
  const daily = barsFrom(chartFrom(dailyPayload, symbol, '1d')).filter(b => b.date < date);
  if (new Set(daily.map(b => b.date)).size !== daily.length) throw new Error('Duplicate daily sessions');
  const previous = daily.at(-1);
  if (!previous || !validBar(previous)) throw new Error('Previous trading session OHLCV is missing or invalid');
  // Deliberately session-seeded: no missing historical candles are bridged or filled.
  const all = barsFrom(chartFrom(intradayPayload, symbol, '5m')).filter(b => b.date === date
    && b.timestamp >= open && b.timestamp < close
    && b.timestamp + STEP <= asOf);
  const map = new Map();
  for (const b of all) {
    if (map.has(b.timestamp)) throw new Error(`Duplicate candle at ${iso(b.timestamp)}`);
    if ((b.timestamp - epoch(b.date, '09:15')) % STEP !== 0) throw new Error('Misaligned 5-minute candle');
    map.set(b.timestamp, b);
  }
  const bars = [];
  for (let time = open; time < cutoff; time += STEP) {
    const b = map.get(time);
    if (!b || !validBar(b)) throw new Error(`Missing/invalid 5-minute OHLCV at ${ist(time)}. No gaps are filled; special sessions are unsupported.`);
    bars.push(b);
  }
  const last = bars.at(-1), closes = bars.map(b => b.close);
  const ema = bars.length >= 20 ? emaSeries(closes) : [];
  const atr = bars.length >= 15 ? wilderAtr(bars) : null;
  const sessionVwap = vwap(bars), deviation = last.close - sessionVwap;
  const hasSlope = finite(ema.at(-1)) && finite(ema.at(-2));
  const warnings = [
    'Historical reconstruction from data fetched now; later provider corrections or corporate-action adjustments may differ from the original feed.',
    'VWAP is a 5-minute HLC3 × volume approximation, not exchange tick VWAP. Price is the last completed candle close.',
    'All intraday indicators reset at 09:15 IST. RSI, EMA and ATR are session-seeded and can differ from charts carrying history across days; ATR excludes the overnight gap.',
    'Support/resistance zones are a mechanical swing heuristic, not confirmed entry signals.',
  ];
  if (bars.length < 21) warnings.push('Not enough completed session candles for every indicator: ROC needs 10, RSI/ATR need 15, EMA needs 20 and EMA slope needs 21. Unavailable values are null, never zero.');
  if (atr === 0) warnings.push('ATR is zero: normalized VWAP deviation is undefined.');
  if (asOf > close) warnings.push('Requested time is after the regular session; candle calculations stop at 15:30 IST.');
  const imbalance = orderBookImbalance(book, symbol, asOf);
  if (imbalance.status === 'unavailable') warnings.push(imbalance.reason);
  return { symbol, yahooSymbol: `${symbol}.NS`, requestedAt: iso(asOf), requestedAtIST: ist(asOf), session: date,
    interval: '5m', lastCandleStart: iso(last.timestamp), lastCandleEnd: iso(last.timestamp + STEP),
    lastCandleEndIST: ist(last.timestamp + STEP), candleLagSeconds: asOf - last.timestamp - STEP,
    historyStart: iso(bars[0].timestamp), historyBars: bars.length, indicatorScope: 'current-session',
    sessionBars: bars.length, sessionVolume: bars.reduce((sum, b) => sum + b.volume, 0),
    parameters: { rsiPeriod: 14, rocPeriod: 9, emaPeriod: 20, emaSlopeBars: 1, atrPeriod: 14,
      swingLeft: 2, swingRight: 2, zoneAtrMultiplier: 0.2, supportResistanceSessions: 1, bookMaxAgeSeconds: 60 },
    price: last.close, vwap: sessionVwap, vwapDeviation: { rupees: deviation,
      percent: deviation / sessionVwap * 100, atrUnits: atr > 0 ? deviation / atr : null },
    atr, rsi: bars.length >= 15 ? rsi(closes) : null, rocPercent: bars.length >= 10 ? roc(closes) : null,
    ema: ema.at(-1) ?? null, previousEma: ema.at(-2) ?? null,
    emaSlopePercent: hasSlope ? (ema.at(-1) / ema.at(-2) - 1) * 100 : null,
    supportResistance: finite(atr) ? supportResistance(bars, last.close, atr)
      : { tolerance: null, minimumTouches: 2, swings: [], zones: [], nearestSupport: null, nearestResistance: null },
    pivots: pivotPoints(previous),
    orderBookImbalance: imbalance, warnings };
}

export function markdownReport(report) {
  const r = report, sr = r.supportResistance, book = r.orderBookImbalance;
  const zone = z => z ? `${money(z.low)}–${money(z.high)} (${z.touches} confirmed swings)` : 'No qualifying zone';
  const bookValue = book.status === 'available' ? `${fmt(book.value)} (${percent(book.value * 100)})` : 'Unavailable — no historical depth snapshot';
  const lines = [
    `# ${r.symbol}: strategy and entry indicators`, '',
    `Requested time: **${r.requestedAtIST}** (${r.requestedAt}).`, '',
    `Last completed candle: **${ist(Date.parse(r.lastCandleStart) / 1000)} → ${r.lastCandleEndIST}**.`, '',
    `Source: Yahoo Finance unofficial chart API (${r.yahooSymbol}); fetched at ${r.fetchedAt ?? 'not recorded'}.`, '',
    `This is a historical indicator report, not an entry decision. No orders were placed.`, '',
    '**Calculation scope: current session, starting at 09:15 IST.** RSI, EMA and ATR are seeded within this session; they do not carry across trading days.', '',
    '| Indicator | Value | Definition |', '| --- | --- | --- |',
    `| Last completed close | ${money(r.price)} | 5-minute close |`,
    `| VWAP | ${money(r.vwap)} | Session cumulative HLC3 × volume / volume |`,
    `| VWAP deviation | ${money(r.vwapDeviation.rupees)} / ${percent(r.vwapDeviation.percent)} | Close − VWAP; percent relative to VWAP |`,
    `| Normalized VWAP deviation | ${fmt(r.vwapDeviation.atrUnits)} ATR | (Close − VWAP) / 5-minute ATR(14) |`,
    `| RSI(14) | ${fmt(r.rsi)} | Wilder smoothing of close changes |`,
    `| ROC(9) | ${percent(r.rocPercent)} | Change from 9 completed bars earlier |`,
    `| EMA(20) | ${money(r.ema)} | SMA seed; smoothing factor 2/21 |`,
    `| EMA slope | ${percent(r.emaSlopePercent)} | Percent change from previous bar's EMA(20) |`,
    `| ATR(14), 5-minute | ${money(r.atr)} | Wilder smoothing of true range |`,
    `| Nearest support zone | ${zone(sr.nearestSupport)} | Below the close; at least 2 confirmed swings |`,
    `| Nearest resistance zone | ${zone(sr.nearestResistance)} | Above the close; at least 2 confirmed swings |`,
    `| Order book imbalance | ${bookValue} | (Bid quantity − ask quantity) / (bid quantity + ask quantity) |`, '',
    '## Previous-session pivot points', '',
    `Based on **${r.pivots.date}**: high ${money(r.pivots.high)}, low ${money(r.pivots.low)}, close ${money(r.pivots.close)}. Traditional pivots; S1 = 2P − prior high.`, '',
    '| Level | Value |', '| --- | --- |',
    ...['S3', 'S2', 'S1', 'P', 'R1', 'R2', 'R3'].map(key => `| ${key} | ${money(r.pivots[key])} |`), '',
    '## Support and resistance zones', '',
    `Current session only. A swing needs 2 lower highs / higher lows on each side. Cluster width is at most **0.2 × ATR = ${money(sr.tolerance)}**, with at least 2 swing observations. Role is assigned relative to the current close.`, '',
    '| Role | Zone | Midpoint | Swing observations | Last confirmation (UTC) |',
    '| --- | --- | --- | --- | --- |',
    ...sr.zones.map(z => `| ${z.role} | ${money(z.low)}–${money(z.high)} | ${money(z.level)} | ${z.touches} | ${z.lastConfirmedAt} |`),
    ...(sr.zones.length ? [] : ['| None | No qualifying clusters | — | — | — |']), '',
    '## Data checks and timing', '',
    `- ${r.sessionBars} completed target-session candles; cumulative volume ${r.sessionVolume.toLocaleString('en-IN')}.`,
    `- ${r.historyBars} session candles; indicator seeding starts ${r.historyStart}. No prior-session intraday candles are used.`,
    `- Last candle ended ${r.candleLagSeconds} seconds before the requested time.`,
    '- Required candles passed timestamp, completeness and OHLCV checks; no missing bars or volume were filled.',
    '- In-progress and later candles were excluded. Pivots use only the preceding session; swing confirmation uses only completed candles.', '',
    '## Order book data', '',
    ...(book.status === 'available' ? [
      `Snapshot: ${book.timestamp}; age ${book.ageSeconds}s; nearest ${book.levelsPerSide} levels per side.`, '',
      `Bid quantity: ${book.bidQuantity}; ask quantity: ${book.askQuantity}. Positive values indicate greater displayed bid quantity; negative values indicate greater displayed ask quantity.`,
    ] : [book.reason, '', 'Supply a recorded snapshot with --book path/to/depth.json. The script rejects another symbol, future snapshots, or snapshots older than 60 seconds.']), '',
    '## Limitations', '', ...r.warnings.map(w => `- ${w}`), '',
    '## Formula references', '',
    '- [VWAP](https://www.tradingview.com/support/solutions/43000502018-volume-weighted-average-price-vwap/)',
    '- [RSI](https://www.tradingview.com/support/solutions/43000502338-relative-strength-index-rsi/)',
    '- [ROC](https://www.tradingview.com/support/solutions/43000502343-rate-of-change-roc/)',
    '- [Traditional pivots](https://www.tradingview.com/support/solutions/43000521824-pivot-points-standard/)',
    '- [Market depth fields](https://kite.trade/docs/connect/v3/market-quotes/)', '',
    '## Reproduce', '', '```sh',
    `node StrategyEntry/calculate-indicators.js --symbol ${r.symbol} --at "${r.requestedAtIST}"`, '```', '',
  ];
  return lines.join('\n');
}

async function fetchChart(symbol, start, end, interval) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol + '.NS')}`);
  url.search = new URLSearchParams({ period1: String(start), period2: String(end), interval, includePrePost: 'false', events: 'splits' });
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(25000) });
      if (response.ok) return { payload: await response.json(), url: url.href };
      const detail = (await response.text()).slice(0, 350);
      throw new Error(`${interval} chart HTTP ${response.status}: ${detail}`);
    } catch (error) {
      if (attempt === 2 || (response && response.status < 500 && response.status !== 429)) {
        throw new Error(`Cannot load ${symbol} ${interval} candles: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    symbol: { type: 'string' }, at: { type: 'string' }, out: { type: 'string' }, book: { type: 'string' },
    'intraday-json': { type: 'string' }, 'daily-json': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('node StrategyEntry/calculate-indicators.js --symbol IRFC --at "2026-11-11T14:00:00+05:30" [--out report.md] [--book depth.json]\nPositional form: node StrategyEntry/calculate-indicators.js IRFC "2026-11-11T14:00:00+05:30"\nOffline replay: supply both --intraday-json raw-5m.json and --daily-json raw-1d.json. Node.js 22+.');
    return;
  }
  if (positionals.length && (values.symbol || values.at || positionals.length !== 2)) throw new Error('Use either --symbol/--at or exactly two positional arguments');
  const symbol = normalizeSymbol(values.symbol ?? positionals[0]);
  const at = values.at ?? positionals[1], asOf = parseTime(at), now = Date.now() / 1000;
  if (asOf > now) throw new Error('Requested timestamp is in the future');
  if (Boolean(values['intraday-json']) !== Boolean(values['daily-json'])) throw new Error('Offline replay requires both --intraday-json and --daily-json');
  const date = istDate(asOf), start = epoch(date, '00:00'), end = Math.floor(asOf);
  if (asOf < epoch(date, '09:20')) throw new Error('No completed regular-session 5-minute candle at the requested time');
  const book = values.book ? JSON.parse(await readFile(values.book, 'utf8')) : null;
  // Validate user-provided depth before fetching anything.
  orderBookImbalance(book, symbol, asOf);
  const load = async (file, interval) => file
    ? { payload: JSON.parse(await readFile(file, 'utf8')), url: `local:${resolve(file)}` }
    : fetchChart(symbol, interval === '1d' ? start - 30 * DAY : start, end, interval);
  const [intraday, daily] = await Promise.all([load(values['intraday-json'], '5m'), load(values['daily-json'], '1d')]);
  const report = calculateIndicators({ symbol, at, intradayPayload: intraday.payload, dailyPayload: daily.payload, book, now });
  report.fetchedAt = new Date().toISOString();
  report.dataMode = values['intraday-json'] ? 'offline-replay' : 'network';
  report.sources = { intraday: intraday.url, daily: daily.url };
  const stamp = ist(asOf).slice(11, 19).replaceAll(':', '');
  const defaultDirectory = new URL('./indicator-results/', import.meta.url);
  const out = values.out ? resolve(values.out) : new URL(`${symbol}-${date}-${stamp}-IST.md`, defaultDirectory).pathname;
  if (!out.endsWith('.md')) throw new Error('--out must end in .md');
  const base = out.slice(0, -3), rawDirectory = `${base}-raw`;
  await mkdir(dirname(out), { recursive: true });
  await mkdir(rawDirectory, { recursive: true });
  await writeFile(join(rawDirectory, '5m.json'), JSON.stringify(intraday.payload, null, 2) + '\n');
  await writeFile(join(rawDirectory, '1d.json'), JSON.stringify(daily.payload, null, 2) + '\n');
  if (book) await writeFile(join(rawDirectory, 'book.json'), JSON.stringify(book, null, 2) + '\n');
  await writeFile(`${base}.json`, JSON.stringify(report, null, 2) + '\n');
  await writeFile(out, markdownReport(report));
  console.log(`Report: ${out}\n${symbol} at ${report.requestedAtIST}; last completed close ₹${fmt(report.price)}\nVWAP ₹${fmt(report.vwap)}; RSI ${fmt(report.rsi)}; ROC ${percent(report.rocPercent)}; EMA slope ${percent(report.emaSlopePercent)}\nOrder book imbalance: ${report.orderBookImbalance.status}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Indicator calculation failed: ${error.message}`); process.exitCode = 1; });
}
