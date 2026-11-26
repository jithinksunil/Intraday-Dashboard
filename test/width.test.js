import assert from 'node:assert/strict';
import { test } from 'node:test';
import { istDay, resample } from '../src/lib/indicators.js';
import { measureFrom, moveWidths, regimeOf } from '../src/lib/width.js';

const ist = (s) => Date.parse(`${s}+05:30`) / 1000;
const k = (t, h, l, c = (h + l) / 2) => ({ t, o: c, h, l, c, v: 100 });

test('regime from the EMA slope per candle: flat is sideways, clear slope is momentum, weak is neither', () => {
  assert.equal(regimeOf(0), 'sideways');
  assert.equal(regimeOf(-0.005), 'sideways');
  assert.equal(regimeOf(0.01), null);
  assert.equal(regimeOf(0.02), 'momentum');
  assert.equal(regimeOf(-0.3), 'momentum');
  assert.equal(regimeOf(null), null);
});

test('measureFrom: 1 ATR out and back, and 2 ATR, timed to the end of the minute that reached them', () => {
  const t0 = ist('2026-11-20T10:00:00');
  const m1 = [
    k(t0, 100.5, 99.8),
    k(t0 + 60, 101.2, 100.3), // up 1 ATR
    k(t0 + 120, 101, 100.4),
    k(t0 + 180, 100.6, 99.9), // back to the start: 4 minutes
    k(t0 + 240, 101.5, 100.5),
    k(t0 + 300, 102.1, 101), // up 2 ATR: 6 minutes
  ];
  assert.deepEqual(measureFrom(m1, 0, t0, 100, 1, istDay(t0)), { reversion: 4, momentum: 6 });
  // A return inside the same candle that went out is not counted: the order inside it is unknown.
  const one = [k(t0, 101.2, 99.5), k(t0 + 60, 100.2, 100.1)];
  assert.equal(measureFrom(one, 0, t0, 100, 1, istDay(t0)).reversion, null);
  // Never past the session: a move finished on the next day does not count.
  const next = [k(t0, 100.2, 99.9), k(ist('2026-11-23T09:15:00'), 103, 97)];
  assert.deepEqual(measureFrom(next, 0, t0, 100, 1, istDay(t0)), { reversion: null, momentum: null });
  assert.deepEqual(measureFrom(m1, 0, t0, 100, 0, istDay(t0)), { reversion: null, momentum: null }, 'no ATR, no measure');
});

// One session of 1-minute candles: price swings ±3 around 100 in a 20-minute cycle.
const swinging = (date, minutes = 375) => Array.from({ length: minutes }, (_, i) => {
  const c = 100 + 3 * Math.sin((2 * Math.PI * i) / 20);
  return k(ist(`${date}T09:15:00`) + i * 60, c + 0.2, c - 0.2, c);
});
const flat = (date, minutes) => Array.from({ length: minutes }, (_, i) => k(ist(`${date}T09:15:00`) + i * 60, 100, 100, 100));

test('moveWidths: averages only starts in the matching market, and counts how often the move happened', () => {
  const m1 = [...swinging('2026-11-19'), ...swinging('2026-11-20')];
  const c5 = resample(m1, 5);
  const atr5 = c5.map(() => 1);
  // 19 Nov: sideways (flat slope) throughout; 20 Nov: momentum (clear slope) throughout.
  const slope = c5.map((c) => (istDay(c.t) === istDay(ist('2026-11-19T10:00:00')) ? 0 : 0.05));
  const w = moveWidths(m1, c5, atr5, slope, istDay(ist('2026-11-21T10:00:00')));
  assert.equal(w.sessions, 2);
  assert.equal(w.sideways.started, 75 - 1, 'every 5-minute close of 19 Nov except the last, which has no minutes after it');
  assert.equal(w.momentum.started, 74);
  assert.ok(w.sideways.count > 60 && w.sideways.count <= w.sideways.started);
  assert.ok(w.sideways.avg > 0 && w.sideways.avg <= 20, 'a 20-minute cycle comes back within a cycle');
  assert.ok(w.momentum.avg > 0 && w.momentum.avg <= 20);
  assert.ok(w.sideways.median > 0);
  assert.equal(w.any.sideways.started, 148, 'any: both sessions, whatever the market');
  assert.equal(w.sideways.completionPct, (w.sideways.count / w.sideways.started) * 100);
});

test('moveWidths: today\'s unfinished moves are pending, not misses; a finished session counts them as misses', () => {
  const m1 = [...flat('2026-11-19', 375), ...flat('2026-11-20', 60)];
  const c5 = resample(m1, 5);
  const w = moveWidths(m1, c5, c5.map(() => 1), c5.map(() => 0), istDay(ist('2026-11-20T10:00:00')));
  assert.equal(w.sideways.started, 74, 'only 19 Nov: price never moved, so every start is a miss');
  assert.equal(w.sideways.count, 0);
  assert.equal(w.sideways.completionPct, 0);
  assert.equal(w.sideways.avg, null);
  assert.equal(w.todayReversion.length, 375);
  assert.equal(w.todayReversion.every((v) => v == null), true);
});

test('moveWidths: today\'s finished moves land on the chart at the minute they started', () => {
  const m1 = swinging('2026-11-20', 120);
  const c5 = resample(m1, 5);
  const w = moveWidths(m1, c5, c5.map(() => 1), c5.map(() => 0), istDay(ist('2026-11-20T10:00:00')));
  // The first start is the close of the 09:15 candle, at 09:20 = session minute 5.
  assert.notEqual(w.todayReversion[5], null);
  assert.equal(w.todayReversion[6], null);
  assert.ok(w.todayMomentum.some((v) => v != null));
});
