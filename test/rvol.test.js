import assert from 'node:assert/strict';
import { test } from 'node:test';
import { istDay } from '../src/lib/indicators.js';
import { buildBaseline, cumulativeCurve, expectedVolume, rvolAt, todayCurve } from '../src/lib/rvol.js';

const ist = (s) => Date.parse(`${s}+05:30`) / 1000;
/** Full 375-minute session with `v` volume per minute. */
const session = (date, v, n = 375) =>
  Array.from({ length: n }, (_, i) => ({ t: ist(`${date}T09:15:00`) + i * 60, o: 1, h: 1, l: 1, c: 1, v }));
const TODAY = istDay(ist('2026-11-20T10:00:00'));
const history = [...session('2026-11-17', 100), ...session('2026-11-18', 200), ...session('2026-11-19', 300)];

test('cumulative curve fills gaps by carrying the total forward', () => {
  const day = session('2026-11-19', 10).filter((_, i) => i !== 1);
  const c = cumulativeCurve(day);
  assert.deepEqual(c.slice(0, 3), [10, 10, 20]);
  assert.equal(c[374], 3740);
});

test('baseline averages prior full sessions only', () => {
  const b = buildBaseline(history, TODAY);
  assert.equal(b.sessions, 3);
  assert.equal(b.curve[0], 200);
  assert.equal(b.curve[374], 200 * 375);
  assert.equal(buildBaseline(history, TODAY, 2).curve[0], 250, 'lookback keeps the most recent sessions');
  const withToday = [...history, ...session('2026-11-20', 9999, 50)];
  assert.equal(buildBaseline(withToday, TODAY).curve[0], 200, 'today is excluded');
  const withShort = [...session('2026-11-16', 5000, 60), ...history];
  assert.equal(buildBaseline(withShort, TODAY).sessions, 3, 'short sessions are excluded');
  assert.equal(buildBaseline([], TODAY), null);
});

test('expected volume interpolates within the minute and clamps to the session', () => {
  const b = buildBaseline(history, TODAY);
  assert.equal(expectedVolume(b, ist('2026-11-20T09:14:59')), null);
  assert.equal(expectedVolume(b, ist('2026-11-20T09:15:00')), null);
  assert.equal(expectedVolume(b, ist('2026-11-20T09:15:30')), 100);
  assert.equal(expectedVolume(b, ist('2026-11-20T09:16:00')), 200);
  assert.equal(expectedVolume(b, ist('2026-11-20T10:15:00')), 200 * 60);
  assert.equal(expectedVolume(b, ist('2026-11-20T15:30:00')), 200 * 375);
  assert.equal(expectedVolume(b, ist('2026-11-20T18:00:00')), 200 * 375);
});

test('rvol is volume so far over expected volume', () => {
  const b = buildBaseline(history, TODAY);
  assert.deepEqual(rvolAt(b, 30000, ist('2026-11-20T10:15:00')), { rvol: 2.5, expected: 12000 });
  assert.equal(rvolAt(b, 500, ist('2026-11-20T09:00:00')), null);
  assert.equal(rvolAt(null, 500, ist('2026-11-20T10:00:00')), null);
});

test('today curve stops at the last stored minute', () => {
  const c = todayCurve([...history, ...session('2026-11-20', 10, 3)], TODAY);
  assert.deepEqual(c.slice(0, 4), [10, 20, 30, null]);
  assert.equal(todayCurve(history, TODAY)[0], null);
});
