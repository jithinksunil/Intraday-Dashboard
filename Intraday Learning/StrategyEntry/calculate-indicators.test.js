import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { calculateIndicators, emaSeries, rsi, roc, vwap, pivotPoints, supportResistance,
  orderBookImbalance, parseTime, normalizeSymbol } from './calculate-indicators.js';

const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const date = '2026-11-11';
const at = `${date}T14:00:00+05:30`;
const open = parseTime(`${date}T09:15:00+05:30`);
const now = parseTime('2026-11-12T00:00:00+05:30');
const candle = (i, close = 100 + Math.sin(i) + i / 20) => ({ timestamp: open + i * 300,
  date, open: close, high: close + 1, low: close - 1, close, volume: 100 + i });
const payload = (bars, interval) => ({ chart: { result: [{ meta: { symbol: 'IRFC.NS', currency: 'INR', dataGranularity: interval },
  timestamp: bars.map(b => b.timestamp), indicators: { quote: [Object.fromEntries(
    ['open', 'high', 'low', 'close', 'volume'].map(k => [k, bars.map(b => b[k])]))] } }], error: null } });
function inputs() {
  return { symbol: 'IRFC', at, now,
    intradayPayload: payload(Array.from({ length: 75 }, (_, i) => candle(i)), '5m'),
    dailyPayload: payload([{ ...candle(0), timestamp: open - 86400, high: 110, low: 90, close: 105 },
      { ...candle(0), high: 10000, close: 9999 }], '1d') };
}

test('known VWAP, Wilder RSI, EMA, ROC and traditional pivot values', () => {
  near(vwap([{ high: 102, low: 98, close: 100, volume: 100 },
    { high: 112, low: 108, close: 110, volume: 300 }]), 107.5);
  near(rsi([10, 12, 11, 13], 2), 100 - 100 / 7);
  assert.equal(rsi([10, 10, 10], 2), 50);
  assert.equal(rsi([10, 11, 12], 2), 100);
  assert.equal(rsi([12, 11, 10], 2), 0);
  assert.deepEqual(emaSeries([10, 12, 14, 16], 3), [null, null, 12, 14]);
  near(roc([100, 110, 121], 2), 21);
  const p = pivotPoints({ date: '2026-11-10', high: 110, low: 90, close: 100 });
  assert.deepEqual([p.S3, p.S2, p.S1, p.P, p.R1, p.R2, p.R3], [70, 80, 90, 100, 110, 120, 130]);
});

test('ISO validation requires a real calendar date and explicit timezone', () => {
  near(parseTime(at), parseTime('2026-11-11T08:30:00Z'));
  for (const bad of ['2026-02-30T14:00:00Z', '2026-13-01T00:00:00Z', '2026-11-11T14:00:00',
    '2026-11-11T24:00:00Z', '2026-11-11T14:00:00+14:30', 'invalid']) {
    assert.throws(() => parseTime(bad), /valid ISO/);
  }
  assert.equal(normalizeSymbol('nse:irfc'), 'IRFC');
  assert.equal(normalizeSymbol('M&M.NS'), 'M&M');
  assert.throws(() => normalizeSymbol('../IRFC'), /Invalid/);
});

test('calculations exclude current/later candles and target-day daily OHLC', () => {
  const options = inputs(), baseline = calculateIndicators(options);
  assert.equal(baseline.sessionBars, 57);
  assert.equal(baseline.lastCandleEnd, '2026-11-11T08:30:00.000Z');
  assert.equal(baseline.pivots.date, '2026-11-10');
  assert.equal(baseline.pivots.high, 110);
  const chart = options.intradayPayload.chart.result[0];
  for (const key of ['open', 'high', 'low', 'close', 'volume']) chart.indicators.quote[0][key].fill(999999, 57);
  options.dailyPayload.chart.result[0].indicators.quote[0].high[1] = 999999;
  assert.deepEqual(calculateIndicators(options), baseline);
  assert.deepEqual(calculateIndicators({ ...options, at: '2026-11-11T08:30:00Z' }), baseline);
});

test('a timestamp inside a candle uses only the previous completed close', () => {
  const result = calculateIndicators({ ...inputs(), at: `${date}T14:02:15+05:30` });
  assert.equal(result.sessionBars, 57);
  assert.equal(result.candleLagSeconds, 135);
});

test('missing, null, duplicate, misaligned and inconsistent target candles fail', () => {
  for (const mutate of [
    chart => { chart.indicators.quote[0].volume[3] = null; },
    chart => { chart.indicators.quote[0].close[3] = null; },
    chart => { chart.indicators.quote[0].high[3] = 1; },
    chart => { chart.timestamp[3] = chart.timestamp[2]; },
    chart => { chart.timestamp[3] += 1; },
    chart => { chart.timestamp[3] += 86400; },
  ]) {
    const options = inputs();
    mutate(options.intradayPayload.chart.result[0]);
    assert.throws(() => calculateIndicators(options), /Missing\/invalid|Duplicate|Misaligned/);
  }
});

test('early-session insufficient history is explicit; zero-volume VWAP fails', () => {
  const result = calculateIndicators({ ...inputs(), at: `${date}T09:20:00+05:30` });
  assert.equal(result.sessionBars, 1);
  for (const k of ['rsi', 'atr', 'ema', 'previousEma', 'emaSlopePercent', 'rocPercent']) assert.equal(result[k], null);
  assert.equal(result.vwapDeviation.atrUnits, null);
  assert.ok(result.warnings.some(w => w.includes('Not enough')));
  const options = inputs();
  options.intradayPayload.chart.result[0].indicators.quote[0].volume.fill(0);
  assert.throws(() => calculateIndicators(options), /positive cumulative volume/);
});

test('future, before-open, nontrading day and mismatched provider data fail', () => {
  assert.throws(() => calculateIndicators({ ...inputs(), now: open }), /future/);
  assert.throws(() => calculateIndicators({ ...inputs(), at: `${date}T09:16:00+05:30` }), /No completed/);
  assert.throws(() => calculateIndicators({ ...inputs(), at: '2026-11-12T10:00:00+05:30', now: now + 86400 }), /Missing\/invalid/);
  for (const [key, value] of [['symbol', 'INFY.NS'], ['currency', 'USD'], ['dataGranularity', '15m']]) {
    const options = inputs();
    options.intradayPayload.chart.result[0].meta[key] = value;
    assert.throws(() => calculateIndicators(options), /mismatched|interval/);
  }
});

test('invalid previous daily close is not replaced by a current quote', () => {
  const options = inputs(), chart = options.dailyPayload.chart.result[0];
  chart.indicators.quote[0].close[0] = null;
  chart.meta.regularMarketPrice = 200;
  assert.throws(() => calculateIndicators(options), /Previous trading session/);
});

test('swing levels require two right-hand candles and cluster repeated levels', () => {
  const prices = [100, 101, 105, 101, 100, 101, 105.1, 101, 100];
  const bars = prices.map((c, i) => candle(i, c));
  const before = supportResistance(bars.slice(0, 8), 102, 1);
  assert.equal(before.zones.length, 0);
  const after = supportResistance(bars, 102, 1);
  assert.equal(after.nearestResistance.touches, 2);
  near(after.nearestResistance.level, 106.05);
  assert.equal(after.nearestResistance.lastConfirmedAt, new Date((open + 9 * 300) * 1000).toISOString());
  assert.ok(after.swings.every(s => Date.parse(s.confirmedAt) <= (open + 9 * 300) * 1000));
});

const snapshot = () => ({ symbol: 'IRFC', timestamp: at, source: 'Synthetic unit test; not market data',
  bids: [{ price: 99, quantity: 300 }, { price: 98, quantity: 100 }],
  asks: [{ price: 101, quantity: 100 }, { price: 102, quantity: 100 }] });

test('order book uses quantities and equal nearest depth levels', () => {
  const book = snapshot();
  book.bids.reverse();
  book.asks.push({ price: 103, quantity: 999999 });
  const result = orderBookImbalance(book, 'IRFC.NS', parseTime(at));
  near(result.value, 1 / 3);
  assert.equal(result.levelsPerSide, 2);
  assert.equal(result.bidQuantity, 400);
  assert.equal(result.askQuantity, 200);
  assert.equal(orderBookImbalance(null, 'IRFC', parseTime(at)).value, null);
});

test('order book rejects stale/future, wrong-symbol and invalid snapshots', () => {
  for (const mutate of [
    b => { b.timestamp = `${date}T13:58:59+05:30`; },
    b => { b.timestamp = `${date}T14:00:01+05:30`; },
    b => { b.symbol = 'INFY'; },
    b => { b.asks = []; },
    b => { b.bids[0].quantity = -1; },
    b => { b.bids[0].price = 103; },
    b => { b.bids.push(b.bids[0]); },
  ]) {
    const book = snapshot(); mutate(book);
    assert.throws(() => orderBookImbalance(book, 'IRFC', parseTime(at)));
  }
});

test('offline CLI writes matching Markdown, JSON and raw evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'indicator-test-'));
  try {
    const options = inputs();
    await writeFile(join(dir, '5m.json'), JSON.stringify(options.intradayPayload));
    await writeFile(join(dir, '1d.json'), JSON.stringify(options.dailyPayload));
    const out = join(dir, 'result.md');
    execFileSync(process.execPath, [fileURLToPath(new URL('./calculate-indicators.js', import.meta.url)), 'IRFC', at,
      '--intraday-json', join(dir, '5m.json'), '--daily-json', join(dir, '1d.json'), '--out', out]);
    const report = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
    const md = await readFile(out, 'utf8');
    assert.equal(report.symbol, 'IRFC');
    assert.equal(report.dataMode, 'offline-replay');
    assert.ok(md.includes(report.rsi.toFixed(4)));
    assert.match(md, /current session/);
    assert.match(md, /Unavailable — no historical depth snapshot/);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'result-raw/5m.json'), 'utf8')), options.intradayPayload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
