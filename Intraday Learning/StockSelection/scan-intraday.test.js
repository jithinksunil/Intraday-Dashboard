import test from 'node:test';
import assert from 'node:assert/strict';
import { addRelativeStrength, benchmarkChange, bias, calculate, depthSummary, fyersSymbol, gate, istDate, normalSessions, parseCsv, relativeAtrBand, rvolBand, score, sessionVolume, spreadBand, spreadPct, toBars, wilderAtr } from './scan-intraday.js';

const bar = (date, extra = {}) => ({ date, open: 100, high: 102, low: 98, close: 100, volume: 1000, ...extra });
const history = Array.from({ length: 35 }, (_, i) => bar(new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10)));
const session = '2026-10-06';
const now = Date.parse('2026-10-06T12:00:00Z') / 1000;

test('ATR accounts for overnight gaps and applies Wilder smoothing', () => {
  const rows = Array.from({ length: 15 }, () => bar('2026-01-01'));
  assert.equal(wilderAtr(rows), 4);
  rows.push(bar('2026-01-02', { open: 110, close: 110, high: 112, low: 108 }));
  assert.equal(wilderAtr(rows), (4 * 13 + 12) / 14);
});

test('daily filters exclude target and future observations from baselines', () => {
  const target = bar(session, { open: 200, close: 210, high: 220, low: 190, volume: 2000 });
  const result = calculate([...history, target, bar('2026-10-07', { volume: 999999 })], [], session, '15:30', now);
  assert.equal(result.rvol, 2);
  assert.equal(result.atrPct, 4);
  assert.equal(result.averageTurnoverCrore, 0.01);
  assert.equal(result.rvolSessions.length, 10);
  assert.equal(result.rvolSessions.at(-1), history.at(-1).date);
  assert.equal(result.relativeAtr, 30); // high 220 down to the previous close of 100, vs a normal range of 4
  assert.equal(result.comparison, 'full-day');
  assert.equal(result.gapPct, 100);
  assert.ok(Math.abs(result.changeFromOpenPct - 5) < 1e-10);
});

test('time-matched RVOL uses exactly the same completed bars on each prior day', () => {
  const intraday = [...history.slice(-20), bar(session)].flatMap(b =>
    [555, 560, 565, 570].map(minute => ({ ...b, minute, volume: minute === 570 ? 999999 : b.date === session ? 200 : 100 })));
  const result = calculate(history, intraday, session, '09:30', now);
  assert.equal(result.rvol, 2);
  assert.equal(result.observedVolume, 600);
  assert.equal(result.baselineVolume, 300);
});

test('missing intraday volume is rejected, not treated as zero', () => {
  const rows = [555, 560, 565].map(minute => ({ ...bar(session), minute }));
  assert.equal(sessionVolume(rows, session, 570).volume, 3000);
  assert.throws(() => sessionVolume(rows.slice(1), session, 570), /Incomplete/);
  rows[1].volume = null;
  assert.throws(() => sessionVolume(rows, session, 570), /Incomplete/);
});

test('future cutoff and invalid daily volume fail closed', () => {
  assert.throws(() => calculate(history, [], '2027-01-01', '15:30', now), /future/);
  const corrupt = history.map(b => ({ ...b }));
  corrupt.at(-1).volume = null;
  assert.throws(() => calculate(corrupt, [], session, '15:30', now), /Invalid prior/);
});

test('CSV handles company commas and escaped quotes; dates use IST', () => {
  assert.deepEqual(parseCsv('Company,Symbol\r\n"Example, ""Ltd""",EXAMPLE\r\n'), [['Company', 'Symbol'], ['Example, "Ltd"', 'EXAMPLE']]);
  assert.equal(istDate(Date.parse('2026-11-11T18:31:00Z') / 1000), '2026-11-12');
});

test('OHLC validation tolerates provider float rounding but rejects material inconsistencies', () => {
  const target = bar(session, { high: 101.999995, close: 102 });
  assert.equal(calculate([...history, target], [], session, '15:30', now).price, 102);
  target.high = 101;
  assert.throws(() => calculate([...history, target], [], session, '15:30', now), /Missing target/);
});

test('RVOL uses the last 10 sessions; relative ATR the last 20; both time-matched', () => {
  const days = history.slice(-20);
  const intraday = [...days, bar(session)].flatMap((b, i) => [555, 560, 565].map(minute => ({ ...b, minute,
    high: b.date === session ? 103 : 102, volume: b.date === session ? 300 : i < 10 ? 500 : 100 })));
  const result = calculate(history, intraday, session, '09:30', now);
  assert.equal(result.rvol, 3); // 900 against the latest ten sessions (300 each), not the older 1500s
  assert.equal(result.relativeAtrSessions, 20);
  assert.equal(result.relativeAtr, 5 / 4);
  assert.equal(result.comparison, '09:15-09:30 time-matched');
});

test('special low-volume sessions and sessions with missing bars are left out of baselines', () => {
  const daily = history.map(b => ({ ...b }));
  daily.at(-1).volume = 50; // e.g. Muhurat session
  assert.equal(normalSessions(daily).length, 34);
  const target = bar(session, { volume: 2000 });
  assert.equal(calculate([...daily, target], [], session, '15:30', now).rvol, 2);
  const intraday = [...history.slice(-12), bar(session)].flatMap(b => [555, 560, 565].map(minute => ({ ...b, minute })))
    .filter(b => !(b.date === history.at(-3).date && b.minute === 560));
  const result = calculate(history, intraday, session, '09:30', now);
  assert.equal(result.rvolSessions.length, 10);
  assert.ok(!result.rvolSessions.includes(history.at(-3).date));
  assert.throws(() => calculate(history, intraday.filter(b => b.date >= history.at(-8).date), session, '09:30', now), /need 10/);
});

test('spread, depth and bands follow the strategy notes', () => {
  assert.ok(Math.abs(spreadPct(99.95, 100.05) - 0.1) < 1e-9);
  assert.equal(spreadPct(0, 100), null);
  assert.equal(spreadPct(100, 0), null);
  assert.deepEqual([spreadBand(0.04), spreadBand(0.08), spreadBand(0.2), spreadBand(null)], ['excellent', 'very good', 'wide', 'unverified']);
  assert.deepEqual([0.5, 1.2, 1.7, 2.5, 4].map(rvolBand), ['below normal', 'moderate', 'good', 'very good', 'excellent']);
  assert.deepEqual([0.4, 0.6, 1, 1.3, 1.7, 2.5, 3.5].map(relativeAtrBand), ['very low', 'below normal', 'normal', 'elevated', 'high', 'very high', 'extreme']);
  const depth = depthSummary({ totalbuyqty: 300, totalsellqty: 100, bids: [{ price: 100, volume: 1000 }, { price: 0, volume: 0 }], ask: [{ price: 100.1, volume: 500 }] });
  assert.equal(depth.imbalance, 0.5);
  assert.equal(depth.top5BidValueLakh, 1);
  assert.equal(depthSummary({ totalbuyqty: 40, totalsellqty: 0, bids: [{ price: 100, volume: 40 }], ask: [{ price: 0, volume: 0 }] }), null);
});

test('gates, relative strength, bias and score', () => {
  const config = { minTurnoverCrore: 20, minAtrPct: 1, minRvol: 1.5, maxSpreadPct: 0.1 };
  const base = { averageTurnoverCrore: 100, atrPct: 2, rvol: 2, relativeAtr: 1.5, spreadPct: null, changeFromOpenPct: 1 };
  assert.deepEqual(gate(base, config), []); // unknown spread does not reject
  assert.deepEqual(gate({ ...base, spreadPct: 0.2, rvol: 1 }, config), ['rvol_below_threshold', 'spread_above_threshold']);
  const rows = addRelativeStrength([
    { ...base, sector: 'Bank', changeFromPreviousClosePct: 3 }, { ...base, sector: 'Bank', changeFromPreviousClosePct: 1 },
    { ...base, sector: 'Bank', changeFromPreviousClosePct: -1 }, { ...base, sector: 'IT', changeFromPreviousClosePct: -2, changeFromOpenPct: -1 },
  ], 0.5);
  assert.equal(rows[0].rsVsNiftyPct, 2.5);
  assert.equal(rows[0].rsVsSectorPct, 3);
  assert.equal(rows[3].rsVsSectorPct, null);
  assert.deepEqual(rows.map(bias), ['long', 'long', 'mixed', 'short']);
  assert.ok(Math.abs(score(rows[0]) - (16 + 20 + 2.5 / 3 * 25)) < 1e-9);
  assert.ok(Math.abs(score({ ...rows[0], spreadPct: 0.04 }) - score(rows[0]) - 15) < 1e-9);
});

test('Fyers symbols, candle conversion and benchmark change', () => {
  assert.equal(fyersSymbol('M&M', 'EQ'), 'NSE:M&M-EQ');
  assert.equal(fyersSymbol('BAJAJ-AUTO'), 'NSE:BAJAJ-AUTO-EQ');
  const [b] = toBars([{ t: Date.parse('2026-11-20T03:45:00Z') / 1000, o: 1, h: 2, l: 1, c: 2, v: 10 }]);
  assert.deepEqual([b.date, b.minute, b.close, b.volume], ['2026-11-20', 555, 2, 10]);
  const daily = [bar('2026-10-05'), bar(session, { close: 102 })];
  assert.ok(Math.abs(benchmarkChange(daily, [], session, '15:30') - 2) < 1e-9);
  const intraday = [{ ...bar(session), minute: 555, close: 101 }, { ...bar(session), minute: 600, close: 105 }];
  assert.ok(Math.abs(benchmarkChange(daily, intraday, session, '09:30') - 1) < 1e-9);
});
