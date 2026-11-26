import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bookCurves, changePct, classifyChange, classifyInterval, classifyShare, cvdStats, DEFAULT_FLOW_CONFIG as CFG, divergence, FlowBook, flowCurves, minutesUntilCovered, windowStats,
} from '../src/lib/orderFlow.js';

const ist = (s) => Date.parse(`${s}+05:30`);
const snap = (o) => ({ vol: 1000, ltp: 100, ltq: 10, bid: 99.95, ask: 100.05, at: 0, dir: 0, ...o });

// ---------- classification ----------
test('trade at or above the ask is buyer-initiated; at or below the bid is seller-initiated', () => {
  const prev = snap({});
  assert.deepEqual(pick(classifyInterval(prev, snap({ vol: 1010, ltp: 100.05, at: 1000 }))), { buy: 10, sell: 0, unclassified: 0, why: 'at ask' });
  assert.deepEqual(pick(classifyInterval(prev, snap({ vol: 1010, ltp: 100.2, at: 1000 }))), { buy: 10, sell: 0, unclassified: 0, why: 'at ask' });
  assert.deepEqual(pick(classifyInterval(prev, snap({ vol: 1010, ltp: 99.95, at: 1000 }))), { buy: 0, sell: 10, unclassified: 0, why: 'at bid' });
  assert.deepEqual(pick(classifyInterval(prev, snap({ vol: 1010, ltp: 99.5, at: 1000 }))), { buy: 0, sell: 10, unclassified: 0, why: 'at bid' });
});
const pick = ({ buy, sell, unclassified, why }) => ({ buy, sell, unclassified, why });

test('inside the spread: nearer side wins; at the midpoint the tick rule decides', () => {
  const prev = snap({ bid: 99.9, ask: 100.1, ltp: 100 });
  assert.equal(classifyInterval(prev, snap({ vol: 1005, ltp: 100.05, at: 500 })).why, 'above mid');
  assert.equal(classifyInterval(prev, snap({ vol: 1005, ltp: 99.95, at: 500 })).why, 'below mid');
  // exactly at the midpoint, price unchanged: the last known direction is used, else unclassified
  assert.equal(classifyInterval({ ...prev, dir: 1 }, snap({ vol: 1005, ltp: 100, at: 500 })).why, 'zero-uptick');
  assert.equal(classifyInterval({ ...prev, dir: -1 }, snap({ vol: 1005, ltp: 100, at: 500 })).sell, 5);
  const none = classifyInterval({ ...prev, dir: 0 }, snap({ vol: 1005, ltp: 100, at: 500 }));
  assert.deepEqual(pick(none), { buy: 0, sell: 0, unclassified: 5, why: 'no direction' });
});

test('missing, crossed or stale quotes fall back to the tick rule, then to unclassified', () => {
  const noQuote = snap({ bid: 0, ask: 0 });
  assert.equal(classifyInterval(noQuote, snap({ vol: 1005, ltp: 100.1, at: 500 })).why, 'uptick');
  assert.equal(classifyInterval(noQuote, snap({ vol: 1005, ltp: 99.9, at: 500 })).why, 'downtick');
  assert.equal(classifyInterval(noQuote, snap({ vol: 1005, ltp: 100, at: 500 })).why, 'no usable quote');
  const crossed = snap({ bid: 100.1, ask: 100 });
  assert.equal(classifyInterval(crossed, snap({ vol: 1005, ltp: 100.1, at: 500 })).why, 'uptick');
  // A quote older than maxQuoteAgeMs is not trusted: price is at the old ask but only the tick rule is used.
  const stale = classifyInterval(snap({}), snap({ vol: 1005, ltp: 100.05, at: CFG.maxQuoteAgeMs + 1 }));
  assert.equal(stale.why, 'uptick');
});

test('a reconnect gap leaves the volume unclassified; duplicates and reversals add nothing', () => {
  const gap = classifyInterval(snap({}), snap({ vol: 5000, ltp: 100.05, at: CFG.maxGapMs + 1 }));
  assert.deepEqual(pick(gap), { buy: 0, sell: 0, unclassified: 4000, why: 'gap' });
  assert.equal(classifyInterval(snap({}), snap({ vol: 1000, at: 500 })).why, 'no volume');
  assert.equal(classifyInterval(snap({}), snap({ vol: 900, at: 500 })).buy, 0);
  assert.equal(classifyInterval(null, snap({})).unclassified, 0);
});

test('volume larger than the last trade is flagged as several trades sharing one label', () => {
  assert.equal(classifyInterval(snap({}), snap({ vol: 1050, ltq: 10, ltp: 100.05, at: 500 })).multi, 50);
  assert.equal(classifyInterval(snap({}), snap({ vol: 1010, ltq: 10, ltp: 100.05, at: 500 })).multi, 0);
});

// ---------- the book ----------
/** Quote record as the feed normalizer produces it. */
const q = (time, vol, o = {}) => ({ k: 'q', sym: 'X', exch: ist(time), recv: ist(time) + 150, ltp: 100, ltq: 1, vol, bid: 99.95, ask: 100.05, ...o });
const AT_ASK = { ltp: 100.05 };
const AT_BID = { ltp: 99.95 };

/** Feeds one snapshot per `stepSec` over [fromMin, toMin) with `perMin` volume, split by sellPct. */
function feed(book, date, fromMin, toMin, { perMin = 600, sellPct = 50, startVol = 0, stepSec = 5 } = {}) {
  let vol = startVol;
  const steps = 60 / stepSec;
  const base = ist(`${date}T09:15:00`);
  const clock = (sec) => new Date(base + sec * 1000 + 19_800_000).toISOString().slice(0, 19);
  // A snapshot one step earlier gives the first interval a baseline (a repeat if the book already has one).
  book.onQuote(q(clock(fromMin * 60 - stepSec), startVol));
  for (let m = fromMin; m < toMin; m++) {
    for (let k = 0; k < steps; k++) {
      const t = clock(m * 60 + k * stepSec);
      const sell = (k * 100) / steps < sellPct;
      vol += perMin / steps;
      book.onQuote(q(t, vol, sell ? AT_BID : AT_ASK));
    }
  }
  return vol;
}

test('book: first snapshot only sets the baseline; later ones land in minute buckets', () => {
  const book = new FlowBook();
  assert.equal(book.onQuote(q('2026-11-20T10:00:00', 5000)), null);
  book.onQuote(q('2026-11-20T10:00:01', 5010, AT_ASK));
  book.onQuote(q('2026-11-20T10:00:02', 5030, AT_BID));
  book.onQuote(q('2026-11-20T10:01:00', 5035, AT_ASK));
  assert.deepEqual(book.sum(45, 46), { buy: 10, sell: 20, unclassified: 0, total: 30 });
  assert.deepEqual(book.sum(46, 47), { buy: 5, sell: 0, unclassified: 0, total: 5 });
  assert.deepEqual(book.sum(0, 375), { buy: 15, sell: 20, unclassified: 0, total: 35 });
  assert.equal(book.stats.buy + book.stats.sell + book.stats.unclassified, 35, 'every unit of volume is accounted for');
});

test('book: duplicates and out-of-order snapshots are ignored; a repeat refreshes the quote', () => {
  const book = new FlowBook();
  book.onQuote(q('2026-11-20T10:00:00', 5000));
  book.onQuote(q('2026-11-20T10:00:01', 5010, AT_ASK));
  assert.equal(book.onQuote(q('2026-11-20T10:00:01', 5010, AT_ASK)), null, 'duplicate');
  assert.equal(book.onQuote(q('2026-11-20T10:00:00', 5005, AT_BID)), null, 'older snapshot arriving late');
  // a repeat with a new quote: the next trade is judged against the refreshed quote
  book.onQuote(q('2026-11-20T10:00:02', 5010, { bid: 100.2, ask: 100.3 }));
  book.onQuote(q('2026-11-20T10:00:03', 5020, { ltp: 100.2 }));
  assert.deepEqual(book.sum(45, 46), { buy: 10, sell: 10, unclassified: 0, total: 20 });
});

test('book: outside 09:15-15:30 nothing is bucketed; a new session resets everything', () => {
  const book = new FlowBook();
  book.onQuote(q('2026-11-20T09:07:00', 100));
  book.onQuote(q('2026-11-20T09:08:00', 9000, AT_ASK)); // pre-open auction volume
  assert.equal(book.sum(0, 375).total, 0);
  book.onQuote(q('2026-11-20T09:15:01', 9100, AT_ASK));
  assert.deepEqual(book.sum(0, 1), { buy: 0, sell: 0, unclassified: 100, total: 100 }, 'the interval spanning the open has no live quote before it');
  assert.equal(book.covered(0, 1), true, 'but it is not a fault: the minute still counts as covered');
  book.onQuote(q('2026-11-20T09:15:02', 9150, AT_ASK));
  assert.equal(book.sum(0, 1).buy, 50, 'classification starts with the next interval');
  book.onQuote(q('2026-11-20T15:31:00', 20000, AT_ASK));
  assert.equal(book.sum(0, 375).total, 150, 'post-close volume is not bucketed');
  // next trading day
  book.onQuote(q('2026-11-23T09:20:00', 50));
  assert.equal(book.sum(0, 375).total, 0);
  assert.equal(cvdStats(book, 5).cvd, 0);
  assert.equal(book.day, Math.floor((ist('2026-11-23T09:20:00') / 1000 + 19_800) / 86_400));
});

test('book: a long silence is unclassified and breaks coverage of that window', () => {
  const book = new FlowBook();
  const v = feed(book, '2026-11-20', 0, 10);
  book.onQuote(q('2026-11-20T09:30:00', v + 7000, AT_ASK)); // 5 minutes of silence
  assert.equal(book.sum(15, 16).unclassified, 7000);
  assert.equal(book.covered(0, 10), true);
  assert.equal(book.covered(10, 15), false, 'no snapshots during the outage');
  assert.equal(book.covered(15, 16), false, 'the minute the gap landed in');
});

test('book: a flagged reconnect leaves the next interval unclassified even if it was short', () => {
  const book = new FlowBook();
  book.onQuote(q('2026-11-20T10:00:00', 5000));
  book.onQuote(q('2026-11-20T10:00:01', 5010, AT_ASK));
  book.markGap();
  book.onQuote(q('2026-11-20T10:00:03', 5510, AT_ASK));
  book.onQuote(q('2026-11-20T10:00:04', 5520, AT_ASK));
  assert.deepEqual(book.sum(45, 46), { buy: 20, sell: 0, unclassified: 500, total: 520 });
  assert.equal(book.covered(45, 46), false);
});

test('book: a quiet stock with seconds between trades is still classified', () => {
  const book = new FlowBook();
  book.onQuote(q('2026-11-20T10:00:00', 5000));
  book.onQuote(q('2026-11-20T10:00:16', 5010, AT_ASK)); // 16 s between trades, as measured live on IRCTC
  book.onQuote(q('2026-11-20T10:00:58', 5015, AT_BID)); // 42 s: quote older than maxQuoteAgeMs -> tick rule
  assert.deepEqual(book.sum(45, 46), { buy: 10, sell: 5, unclassified: 0, total: 15 });
  assert.equal(book.stats.why['at ask'], 10);
  assert.equal(book.stats.why.downtick, 5);
});

// ---------- shares and changes ----------
test('sell and buy volume share over the last three completed candles', () => {
  const book = new FlowBook();
  feed(book, '2026-11-20', 0, 32, { sellPct: 75 });
  const w = windowStats(book, 32);
  assert.equal(w.windowEnd, 30, 'the forming 09:45 candle is left out');
  assert.equal(w.recent.total, 15 * 600);
  assert.equal(w.sellShare, 75);
  assert.equal(w.buyShare, 25);
  assert.equal(w.unclassifiedShare, 0);
  assert.equal(w.dominance, 'strong selling dominance');
});

// ---------- windows that end at the current moment (values move with every quote) ----------
test('moving window: the share follows the last 15 minutes instead of waiting for a candle to close', () => {
  const book = new FlowBook();
  const v = feed(book, '2026-11-20', 0, 30, { sellPct: 75 });
  feed(book, '2026-11-20', 30, 33, { sellPct: 0, startVol: v }); // three minutes of pure buying
  assert.equal(windowStats(book, 32).sellShare, 75, 'completed candles: still the 09:30-09:45 window');
  // at the end of minute 32 the window is minutes 18-32: 12 minutes at 75% sell, 3 at 0%
  const w = windowStats(book, 32, CFG, 1);
  assert.equal(w.recent.total, 15 * 600);
  assert.equal(w.sellShare, 60);
  assert.equal(w.dominance, 'moderate selling dominance');
  assert.equal(w.minutesUntilShare, 0);
  // part-way through a minute, the minute at the old edge counts for the part still inside the window
  const half = windowStats(book, 32, CFG, 0.5);
  assert.equal(half.recent.total, 15 * 600 + 300);
  assert.ok(Math.abs(half.sellShare - (5625 / 9300) * 100) < 1e-9);
});

test('moving window: changes compare the 15 minutes ending now with the 15 before', () => {
  const book = new FlowBook();
  const v = feed(book, '2026-11-20', 0, 16, { perMin: 600 });
  feed(book, '2026-11-20', 16, 31, { perMin: 1200, startVol: v });
  const w = windowStats(book, 30, CFG, 1); // recent = minutes 16-30, previous = minutes 1-15
  assert.equal(w.sellChangePct, 100);
  assert.equal(w.buyChangePct, 100);
  assert.equal(w.totalChangePct, 100);
  assert.equal(w.sellChange, 'increasing');
  assert.equal(w.minutesUntilChange, 0);
  // one minute earlier the earlier window would start before the open
  const early = windowStats(book, 29, CFG, 1);
  assert.equal(early.sellChangePct, null);
  assert.equal(early.minutesUntilChange, 1);
  assert.notEqual(early.sellShare, null, 'the share only needs one window');
});

test('moving window: figures are withheld until the window is fully covered, with the wait', () => {
  const book = new FlowBook();
  feed(book, '2026-11-20', 45, 61); // started watching just before 10:00: the first snapshot lands in minute 44
  assert.equal(windowStats(book, 52, CFG, 0.3).sellShare, null);
  assert.equal(windowStats(book, 52, CFG, 0.3).minutesUntilShare, 7);
  assert.equal(windowStats(book, 58, CFG, 0.3).sellShare, null);
  assert.equal(windowStats(book, 59, CFG, 0.3).sellShare, 50);
  assert.equal(windowStats(book, 59, CFG, 0.3).minutesUntilChange, 15);
  // a reconnect gap inside the window withholds it again
  book.broken[55] = true;
  assert.equal(windowStats(book, 59, CFG, 0.3).sellShare, null);
  assert.equal(windowStats(book, 59, CFG, 0.3).minutesUntilShare, 12);
});

test('moving window: CVD change and trend are measured back from the current moment', () => {
  const book = new FlowBook();
  feed(book, '2026-11-20', 5, 36, { sellPct: 25 }); // net +300 a minute
  const c = cvdStats(book, 35, CFG, 1);
  assert.equal(c.cvd, 31 * 300);
  assert.equal(c.cvdRate, 15 * 300);
  assert.equal(c.cvdTrend, 'rising');
  assert.ok(Math.abs(c.cvdSlopeShare - 0.5) < 1e-9);
  assert.equal(c.minutesUntilTrend, 0);
  const early = cvdStats(book, 33, CFG, 1); // 30 minutes back from here reaches minute 3, before coverage began
  assert.equal(early.cvdTrend, null);
  assert.equal(early.minutesUntilTrend, 1);
});

test('share bands', () => {
  assert.equal(classifyShare(60.1), 'strong selling dominance');
  assert.equal(classifyShare(60), 'moderate selling dominance');
  assert.equal(classifyShare(55), 'moderate selling dominance');
  assert.equal(classifyShare(54.9), 'balanced');
  assert.equal(classifyShare(45.1), 'balanced');
  assert.equal(classifyShare(45), 'moderate buying dominance');
  assert.equal(classifyShare(40), 'moderate buying dominance');
  assert.equal(classifyShare(39.9), 'strong buying dominance');
  assert.equal(classifyShare(null), null);
});

test('sell and buy volume change between two consecutive 15-minute windows', () => {
  const book = new FlowBook();
  let v = feed(book, '2026-11-20', 5, 20, { perMin: 600, sellPct: 50 }); // previous: 4500 sell, 4500 buy
  feed(book, '2026-11-20', 20, 35, { perMin: 600, sellPct: 75, startVol: v }); // recent: 6750 sell, 2250 buy
  const w = windowStats(book, 35);
  assert.equal(w.sellChangePct, 50);
  assert.equal(w.buyChangePct, -50);
  assert.equal(w.totalChangePct, 0);
  assert.equal(w.sellChange, 'increasing');
  assert.equal(w.buyChange, 'decreasing');
});

test('change: zero previous volume and bands never give NaN or Infinity', () => {
  assert.equal(changePct(100, 0), null);
  assert.equal(changePct(0, 0), null);
  assert.equal(changePct(null, 50), null);
  assert.equal(changePct(0, 50), -100);
  assert.equal(classifyChange(20.1), 'increasing');
  assert.equal(classifyChange(20), 'flat');
  assert.equal(classifyChange(-20), 'flat');
  assert.equal(classifyChange(-20.1), 'decreasing');
  assert.equal(classifyChange(null), null);
  // previous window had only buying: sell change is unavailable, buy change still works
  const book = new FlowBook();
  const v = feed(book, '2026-11-20', 5, 20, { sellPct: 0 });
  feed(book, '2026-11-20', 20, 35, { sellPct: 50, startVol: v });
  const w = windowStats(book, 35);
  assert.equal(w.sellChangePct, null);
  assert.equal(w.sellChange, null);
  assert.equal(w.buyChangePct, -50);
});

test('windows need full coverage: figures are withheld, with the minutes still needed', () => {
  const book = new FlowBook();
  feed(book, '2026-11-20', 62, 80); // server started at 10:17
  let w = windowStats(book, 80); // 10:35: only 15 covered minutes end at 10:35? window 10:20-10:35 is covered
  assert.equal(w.windowEnd, 80);
  assert.equal(w.sellShare, 50);
  assert.equal(w.sellChangePct, null, 'previous window 10:05-10:20 is only partly covered');
  assert.equal(w.minutesUntilChange, 15, 'first full pair of windows ends at 10:50');
  w = windowStats(book, 70);
  assert.equal(w.sellShare, null);
  assert.equal(w.minutesUntilShare, 10, 'first full window is 10:20-10:35');
  assert.equal(windowStats(new FlowBook(), 100).sellShare, null);
});

// ---------- CVD ----------
test('CVD accumulates buy minus sell, and its rate and trend follow the flow', () => {
  const book = new FlowBook();
  let v = feed(book, '2026-11-20', 5, 35, { sellPct: 25 }); // net +300 a minute
  let c = cvdStats(book, 35);
  assert.equal(c.cvd, 30 * 300);
  assert.equal(c.cvdRate, 15 * 300);
  assert.equal(c.cvdTrend, 'rising');
  assert.ok(Math.abs(c.cvdSlopeShare - 0.5) < 1e-9, 'net buying is half of the volume');
  v = feed(book, '2026-11-20', 35, 65, { sellPct: 75, startVol: v }); // net -300 a minute
  c = cvdStats(book, 65);
  assert.equal(c.cvd, 0);
  assert.equal(c.cvdTrend, 'falling');
  feed(book, '2026-11-20', 65, 95, { sellPct: 50, startVol: v });
  c = cvdStats(book, 95);
  assert.equal(c.cvdTrend, 'sideways');
  assert.equal(c.cvdRate, 0);
});

test('CVD trend needs 30 covered minutes', () => {
  const book = new FlowBook();
  feed(book, '2026-11-20', 5, 25, { sellPct: 25 });
  const c = cvdStats(book, 25);
  assert.equal(c.cvdTrend, null);
  assert.equal(c.minutesUntilTrend, 10);
  assert.equal(c.cvd, 20 * 300);
});

test('divergence only on confirmed swings: lower low in price with a higher low in CVD', () => {
  const book = new FlowBook();
  let v = feed(book, '2026-11-20', 0, 20, { sellPct: 75 }); // CVD falls to -6000
  v = feed(book, '2026-11-20', 20, 60, { sellPct: 25, startVol: v }); // then rises
  const t = (min) => ist('2026-11-20T09:15:00') / 1000 + min * 60;
  // price swing lows at the 09:30 candle (CVD -6000) and the 10:00 candle (higher CVD), price lower
  assert.equal(divergence(book, [{ t: t(15), price: 100 }, { t: t(45), price: 99 }], []), 'bullish');
  assert.equal(divergence(book, [{ t: t(15), price: 100 }, { t: t(45), price: 101 }], []), null, 'price made a higher low');
  assert.equal(divergence(book, [{ t: t(45), price: 99 }], []), null, 'one swing is not enough');
  // bearish: higher high in price while CVD is lower
  const b2 = new FlowBook();
  v = feed(b2, '2026-11-20', 0, 20, { sellPct: 25 });
  feed(b2, '2026-11-20', 20, 60, { sellPct: 75, startVol: v });
  assert.equal(divergence(b2, [], [{ t: t(15), price: 100 }, { t: t(45), price: 101 }]), 'bearish');
  // swings from another day are ignored
  assert.equal(divergence(b2, [], [{ t: t(15) - 86_400, price: 100 }, { t: t(45), price: 101 }]), null);
});

// ---------- persistence and replay ----------
test('saving and restoring keeps buckets, coverage and CVD; replay equals live', () => {
  const live = new FlowBook();
  const records = [];
  const tap = { onQuote: (r) => { records.push(r); return live.onQuote(r); } };
  const v = feed(tap, '2026-11-20', 0, 30, { sellPct: 40 });
  // replaying the same records through a fresh book gives identical state
  const replay = new FlowBook();
  for (const r of records) replay.onQuote(r);
  assert.deepEqual(replay.toJSON(), live.toJSON());

  // restart mid-session: restore, then carry on
  const restored = FlowBook.fromJSON(JSON.parse(JSON.stringify(live.toJSON())));
  assert.deepEqual(windowStats(restored, 30), windowStats(live, 30));
  assert.equal(cvdStats(restored, 30).cvd, cvdStats(live, 30).cvd);
  // the first snapshot after the restart sets the baseline; volume traded while down is not guessed
  assert.equal(restored.onQuote(q('2026-11-20T09:50:00', v + 9999, AT_ASK)), null);
  restored.onQuote(q('2026-11-20T09:50:01', v + 9999 + 10, AT_ASK));
  assert.equal(restored.sum(35, 36).buy, 10);
  assert.equal(restored.covered(30, 35), false, 'downtime is not covered');
  assert.equal(restored.covered(35, 36), false, 'nor is the minute it came back in, even after a short restart');
  // a saved session from another day is dropped by the first quote of the new day
  restored.onQuote(q('2026-11-23T09:20:00', 5));
  assert.equal(restored.sum(0, 375).total, 0);
});

test('the wait shown accounts for a break in coverage', () => {
  // Started 13:00, restarted just before 13:02 (minute 226 broken), now 13:07.
  const book = new FlowBook();
  const v = feed(book, '2026-11-20', 225, 227);
  const resumed = FlowBook.fromJSON(JSON.parse(JSON.stringify(book.toJSON())));
  feed(resumed, '2026-11-20', 227, 232, { startVol: v });
  assert.equal(resumed.covered(226, 227), false, 'the minute the server came back in');
  assert.equal(minutesUntilCovered(resumed, 232, 15), 13, 'first clean window is 13:05-13:20');
  assert.equal(windowStats(resumed, 232).minutesUntilShare, 13);
  assert.equal(windowStats(resumed, 232).minutesUntilChange, 28);
  assert.equal(cvdStats(resumed, 232).minutesUntilTrend, 28);
  assert.equal(minutesUntilCovered(new FlowBook(), 232, 15), null);
  // Without the break it would have been ready at 13:15.
  const clean = new FlowBook();
  feed(clean, '2026-11-20', 225, 232);
  assert.equal(minutesUntilCovered(clean, 232, 15), 8);
});

// ---------- curves for the charts ----------
test('flowCurves: each point equals the live window ending at that minute, and gaps leave holes', () => {
  const book = new FlowBook(CFG);
  book.reset(1);
  for (let i = 0; i < 60; i++) {
    book.buckets[i] = { b: 100 + i * 3, s: 200 - i * 2, u: 5, m: 0 };
    book.seen[i] = true;
  }
  const fc = flowCurves(book, CFG);
  for (const m of [15, 29, 30, 44, 59]) {
    const w = windowStats(book, m, CFG, 1);
    assert.equal(fc.sellShare[m], w.sellShare, `share at ${m}`);
    assert.equal(fc.sellChange[m], w.sellChangePct, `sell change at ${m}`);
    assert.equal(fc.buyChange[m], w.buyChangePct, `buy change at ${m}`);
    assert.equal(fc.totalChange[m], w.totalChangePct, `total change at ${m}`);
  }
  assert.equal(fc.sellShare[14], null, 'the first window needs 15 whole minutes before the current one');
  assert.notEqual(fc.sellShare[15], null);
  assert.equal(fc.sellShare[60], null, 'nothing after the last snapshot');
  // At the newest minute the chart point is the live CVD rate and trend.
  const c = cvdStats(book, 59, CFG, 1);
  assert.equal(fc.cvdRate[59], c.cvdRate);
  assert.ok(Math.abs(fc.cvdSlope[59] - c.cvdSlopeShare) < 1e-12);
  assert.equal(fc.cvdSlope[29], null);
  assert.notEqual(fc.cvdSlope[30], null);

  book.broken[40] = true;
  const gap = flowCurves(book, CFG);
  assert.equal(gap.sellShare[55], null, 'a window that includes the reconnect minute is not drawn');
  assert.notEqual(gap.sellShare[56], null);
});

test('bookCurves: minute averages, whole-book imbalance, quantity trends and depth samples', () => {
  const book = new FlowBook(CFG);
  book.reset(1);
  for (let i = 0; i < 40; i++) {
    const buy = i < 20 ? 1000 : 1200;
    book.addBookQty(i, buy, 500);
    book.addBookQty(i, buy, 500);
  }
  book.addDepth(3, 0.04, 0.2);
  book.addDepth(3, 0.06, null);
  book.addDepth(4, null, null); // nothing usable: no entry
  const bc = bookCurves(book, 15, 12);
  assert.equal(bc.buyQty[5], 1000);
  assert.equal(bc.sellQty[5], 500);
  assert.ok(Math.abs(bc.imbalance[5] - 1 / 3) < 1e-12);
  assert.ok(Math.abs(bc.spreadPct[3] - 0.05) < 1e-12);
  assert.equal(bc.imbalance5[3], 0.2);
  assert.equal(bc.spreadPct[4], null);
  assert.equal(bc.bidTrend[28], null, 'needs two full windows');
  // minutes 15-29 average (5 x 1000 + 10 x 1200) / 15 against 1000 for minutes 0-14
  assert.ok(Math.abs(bc.bidTrend[29] - ((5 * 1000 + 10 * 1200) / 15 / 1000 - 1) * 100) < 1e-9);
  assert.equal(bc.askTrend[29], 0);
  assert.equal(bc.bidTrend[45], null, 'no readings at that minute');
  // Too few readings in a window: no trend.
  for (let i = 20; i < 25; i++) book.bookQty[i] = null;
  assert.equal(bookCurves(book, 15, 12).bidTrend[34], null);
  // Depth samples survive a restart.
  const back = FlowBook.fromJSON(JSON.parse(JSON.stringify(book.toJSON())), CFG);
  assert.deepEqual(back.depth[3], book.depth[3]);
  assert.equal(FlowBook.fromJSON({ day: 1, buckets: {} }, CFG).depth.every((k) => k == null), true, 'older saved files have no depth');
});
