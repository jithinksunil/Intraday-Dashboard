import assert from 'node:assert/strict';
import { test } from 'node:test';
import { istDay } from '../src/lib/indicators.js';
import { buildBaseline, cumulativeAt, cumulativeCurve, expectedVolume, rvolAt, todayCurve, volumeBetween, windowRvol } from '../src/lib/rvol.js';

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

test('windowRvol compares a recent window with the same minutes on earlier sessions', () => {
  const b = buildBaseline(history, TODAY); // 200 a minute on average
  // Today: 600 a minute for the first 15 minutes, then 100 a minute for the next 15.
  const today = [...session('2026-11-20', 600, 15), ...session('2026-11-20', 100, 30).slice(15)];
  const cum = todayCurve([...history, ...today], TODAY);
  assert.deepEqual(windowRvol(cum, b, 15, 15), { volume: 9000, usual: 3000, rvol: 3 });
  assert.deepEqual(windowRvol(cum, b, 30, 15), { volume: 1500, usual: 3000, rvol: 0.5 });
  assert.equal(windowRvol(cum, b, 35, 15), null, 'minutes 30-34 are not stored yet');
  assert.equal(windowRvol(cum, b, 10, 15), null, 'window starts before the open');
  assert.equal(windowRvol(cum, null, 30, 15), null);
});

test('cumulativeAt reads a per-minute total at any moment, interpolating inside a minute', () => {
  const curve = [100, 300, 600, null, null, 900]; // totals at the end of minutes 0..5
  assert.equal(cumulativeAt(curve, 0, { fromZero: true }), 0);
  assert.equal(cumulativeAt(curve, 0), null, 'a feed total has no known value at the open');
  assert.equal(cumulativeAt(curve, 2), 300);
  assert.equal(cumulativeAt(curve, 2.5), 450);
  assert.equal(cumulativeAt(curve, 0.5, { fromZero: true }), 50);
  assert.equal(cumulativeAt(curve, 4.5), null, 'minutes 3 and 4 are missing');
  assert.equal(cumulativeAt(curve, 4.5, { maxGap: 3 }), 750, 'bridged between minute 2 and minute 5');
  assert.equal(cumulativeAt(curve, -1), null);
});

test('volumeBetween joins stored candles to the live feed without mixing their totals', () => {
  // Candles: 100 a minute for minutes 0-9. Feed: watched from minute 8, and runs 5,000 above the candle total.
  const stored = Array.from({ length: 375 }, (_, i) => (i < 10 ? (i + 1) * 100 : null));
  const live = Array.from({ length: 375 }, (_, i) => (i >= 8 && i < 14 ? 5000 + (i + 1) * 100 : null));
  assert.equal(volumeBetween(live, stored, 2, 7), 500, 'both ends inside the candles');
  assert.equal(volumeBetween(live, stored, 10, 13), 300, 'both ends inside the feed');
  assert.equal(volumeBetween(live, stored, 4, 13), 900, 'candles to minute 9, feed after: the 5,000 offset cancels');
  assert.equal(volumeBetween(live, stored, 4, 14.5, { t: 14.5, volume: 6450 }), 1050, 'ending at the current moment');
  assert.equal(volumeBetween(null, stored, 4, 13), null, 'the candles do not reach minute 13 and there is no feed');
  const noOverlap = live.map((v, i) => (i >= 11 ? v : null)); // the feed started after the last stored minute
  assert.equal(volumeBetween(noOverlap, stored, 4, 13), null);
});
