import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ind from '../src/lib/indicators.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const ist = (s) => Date.parse(`${s}+05:30`) / 1000;
const bar = (t, o, h, l, c, v = 100) => ({ t, o, h, l, c, v });
/** n one-minute bars from 09:15 on a date, close rising by `step`. */
const session = (date, n, { start = 100, step = 0, v = 100 } = {}) =>
  Array.from({ length: n }, (_, i) => {
    const c = start + i * step;
    return bar(ist(`${date}T09:15:00`) + i * 60, c, c + 1, c - 1, c, v);
  });

test('sma and ema', () => {
  assert.deepEqual(ind.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ind.ema([1, 2, 3, 4, 5], 3); // seed = 2, alpha = 0.5
  assert.deepEqual(e, [null, null, 2, 3, 4]);
  near(ind.ema([10, 10, 10, 16], 3)[3], 13);
});

test('pctChange / roc', () => {
  assert.deepEqual(ind.roc([100, 110, 121], 1).map((x) => (x == null ? null : Math.round(x))), [null, 10, 10]);
});

test('rsi: all gains 100, all losses 0, flat 50, known value', () => {
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.equal(ind.last(ind.rsi(up, 14)), 100);
  assert.equal(ind.last(ind.rsi([...up].reverse(), 14)), 0);
  assert.equal(ind.last(ind.rsi(new Array(20).fill(5), 14)), 50);
  // alternating +2, -1 over 14 changes: avg gain 1, avg loss 0.5 -> RS 2 -> RSI 66.67
  const alt = [100];
  for (let i = 0; i < 14; i++) alt.push(alt[i] + (i % 2 ? -1 : 2));
  near(ind.rsi(alt, 14)[14], 100 - 100 / 3);
});

test('atr: constant range, and gaps count through true range', () => {
  const flat = Array.from({ length: 30 }, (_, i) => bar(i * 60, 100, 102, 98, 100));
  near(ind.last(ind.atr(flat, 14)), 4);
  assert.deepEqual(ind.trueRanges([bar(0, 100, 101, 99, 100), bar(60, 110, 111, 109, 110)]), [2, 11]);
  near(ind.relativeAtr(ind.atr(flat, 14)), 1);
});

test('adx: steady uptrend gives +DI > -DI and ADX near 100; needs 2n bars', () => {
  const up = Array.from({ length: 60 }, (_, i) => bar(i * 60, 100 + i, 101 + i, 99 + i, 100 + i));
  const r = ind.adx(up, 14);
  assert.ok(ind.last(r.plusDI) > 40 && ind.last(r.minusDI) === 0);
  assert.ok(ind.last(r.adx) > 99);
  assert.equal(ind.last(ind.adx(up.slice(0, 20), 14).adx), null);
  const down = up.map((k, i) => bar(i * 60, 200 - i, 201 - i, 199 - i, 200 - i));
  assert.ok(ind.last(ind.adx(down, 14).minusDI) > ind.last(ind.adx(down, 14).plusDI));
});

test('macd: flat series is zero; rising series has positive line', () => {
  const flat = ind.macd(new Array(60).fill(50));
  near(ind.last(flat.line), 0);
  near(ind.last(flat.hist), 0);
  const rising = ind.macd(Array.from({ length: 80 }, (_, i) => 100 + i));
  assert.ok(ind.last(rising.line) > 0);
  assert.equal(rising.signal[32], null); // signal needs 26 + 9 - 1 bars
  assert.notEqual(rising.signal[33], null);
});

test('bollinger: known window', () => {
  const b = ind.bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2); // mean 5, population sd 2
  near(ind.last(b.mid), 5);
  near(ind.last(b.upper), 9);
  near(ind.last(b.lower), 1);
  near(ind.last(b.pctB), 1);
  near(ind.last(b.widthPct), 160);
});

test('resample anchors buckets at 09:15 and aggregates OHLCV', () => {
  const m1 = session('2026-11-18', 7, { step: 1 });
  const m5 = ind.resample(m1, 5);
  assert.equal(m5.length, 2);
  assert.deepEqual(m5[0], { t: ist('2026-11-18T09:15:00'), o: 100, h: 105, l: 99, c: 104, v: 500 });
  assert.equal(m5[1].t, ist('2026-11-18T09:20:00'));
  assert.equal(m5[1].v, 200);
});

test('toDaily and sessions split on IST days', () => {
  const two = [...session('2026-11-17', 3, { start: 50 }), ...session('2026-11-18', 2, { start: 60, step: 5 })];
  const d = ind.toDaily(two);
  assert.equal(d.length, 2);
  assert.deepEqual({ o: d[1].o, h: d[1].h, l: d[1].l, c: d[1].c, v: d[1].v }, { o: 60, h: 66, l: 59, c: 65, v: 200 });
  assert.deepEqual(ind.sessions(two).map((s) => s.length), [3, 2]);
});

test('vwap weights by volume; anchored vwap starts at the anchor', () => {
  const c = [bar(0, 10, 10, 10, 10, 100), bar(60, 20, 20, 20, 20, 300)];
  assert.deepEqual(ind.vwap(c), [10, 17.5]);
  assert.equal(ind.anchoredVwap(c, 60), 20);
  assert.equal(ind.vwap([bar(0, 1, 1, 1, 1, 0)])[0], null);
});

test('pivots from previous day', () => {
  const p = ind.pivots({ h: 110, l: 100, c: 105 });
  assert.deepEqual([p.p, p.r1, p.s1, p.r2, p.s2], [105, 110, 100, 115, 95]);
});

test('swings and nearest levels', () => {
  const prices = [5, 6, 7, 9, 7, 6, 4, 6, 7, 8, 7];
  const c = prices.map((p, i) => bar(i * 60, p, p + 0.5, p - 0.5, p));
  const s = ind.swings(c, 2);
  assert.deepEqual(s.highs.map((x) => x.price), [9.5]);
  assert.deepEqual(s.lows.map((x) => x.price), [3.5]);
  assert.deepEqual(ind.nearestLevels(c, 7, 2), { support: 3.5, resistance: 9.5 });
  // A rise into a flat stretch is not a swing; a double top counts once, at its first bar.
  const flatTop = [1, 2, 3, 3, 3].map((p, i) => bar(i * 60, p, p, p, p));
  assert.deepEqual(ind.swings(flatTop, 2).highs, []);
  const doubleTop = [1, 2, 5, 5, 3, 2, 1].map((p, i) => bar(i * 60, p, p, p, p));
  assert.deepEqual(ind.swings(doubleTop, 2).highs.map((x) => x.t), [120]);
});

test('volume profile: POC and 70% value area', () => {
  const at = (p, v) => bar(0, p, p, p, p, v);
  const prof = ind.volumeProfile([at(100, 10), at(101, 50), at(102, 20), at(103, 10), at(104, 10)], 1);
  assert.deepEqual(prof, { poc: 101, vah: 102, val: 101 }); // 50 + 20 = 70 of 100
  assert.equal(ind.volumeProfile([at(100, 0)], 1), null);
});

test('rvol compares against the same time of day', () => {
  const prior = ['2026-11-16', '2026-11-17'].flatMap((d) => session(d, 100, { v: 100 }));
  const today = session('2026-11-18', 10, { v: 250 });
  near(ind.rvol([...prior, ...today], 20), 2.5); // 2500 today vs 1000 by the same minute
  assert.equal(ind.rvol(today), null);
});

test('chandelier, returnPct, correlation', () => {
  const flat = Array.from({ length: 30 }, (_, i) => bar(i * 60, 100, 102, 98, 100));
  const ch = ind.last(ind.chandelier(flat, 22, 3));
  near(ch.long, 102 - 12);
  near(ch.short, 98 + 12);
  near(ind.returnPct([bar(0, 1, 1, 1, 100), bar(60, 1, 1, 1, 110)], 1), 10);
  near(ind.correlation([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  near(ind.correlation([1, 2, 3, 4], [8, 6, 4, 2]), -1);
});
