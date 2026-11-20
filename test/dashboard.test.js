import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createDashboardServer } from '../src/lib/dashboardServer.js';
import { FlowBook } from '../src/lib/orderFlow.js';
import { RvolEngine } from '../src/lib/rvolEngine.js';

const ist = (s) => Date.parse(`${s}+05:30`) / 1000;
const session = (date, v, n = 375) =>
  Array.from({ length: n }, (_, i) => ({ t: ist(`${date}T09:15:00`) + i * 60, o: 1, h: 1, l: 1, c: 1, v }));
const SYM = 'NSE:SBIN-EQ';
const quote = (time, vol, extra = {}) => ({ k: 'q', sym: SYM, exch: ist(time) * 1000, recv: ist(time) * 1000 + 200, ltp: 110, pc: 100, vol, ...extra });

function engineWith(candles, opts = {}) {
  const stored = { candles };
  const engine = new RvolEngine({ symbols: [SYM], loadCandles: () => stored.candles, ...opts });
  return { engine, stored };
}
const HISTORY = [...session('2026-11-18', 100), ...session('2026-11-19', 300)];

test('engine computes live RVOL from exchange time and tracks the row', () => {
  const { engine } = engineWith([...HISTORY, ...session('2026-11-20', 500, 30)]);
  assert.equal(engine.row(SYM).rvol, null);
  const row = engine.onQuote(quote('2026-11-20T10:15:00', 30000));
  assert.equal(row.expected, 200 * 60);
  assert.equal(row.rvol, 2.5);
  assert.equal(row.changePct, 10);
  assert.equal(row.baselineSessions, 2);
  const d = engine.detail(SYM);
  assert.equal(d.average.length, 375);
  assert.equal(d.today[29], 15000, 'stored candles fill the earlier part of today');
  assert.equal(d.today[30], null);
  assert.equal(d.today[60], 30000, 'live volume lands on the current minute');
});

test('engine: before the open RVOL is null; after the close it uses the full-day average', () => {
  const { engine } = engineWith(HISTORY);
  assert.equal(engine.onQuote(quote('2026-11-20T09:10:00', 5000)).rvol, null);
  assert.equal(engine.onQuote(quote('2026-11-20T15:59:00', 150000)).rvol, 2);
});

test('engine: untracked symbols and non-quote records are ignored', () => {
  const { engine } = engineWith(HISTORY);
  assert.equal(engine.onQuote({ ...quote('2026-11-20T10:00:00', 1), sym: 'NSE:OTHER-EQ' }), null);
  assert.equal(engine.onQuote({ ...quote('2026-11-20T10:00:00', 1), k: 'i' }), null);
});

test('engine: a new session rebuilds the baseline, asks for a history refresh, and reload keeps live points', () => {
  const newDays = [];
  const { engine, stored } = engineWith(HISTORY, { onNewDay: (sym, day) => newDays.push([sym, day]) });
  engine.onQuote(quote('2026-11-20T10:15:00', 30000));
  assert.equal(newDays.length, 0, 'first quote is not a day change');
  // Monday: Friday's candles are not stored yet, so the baseline is still the two old sessions.
  const stale = engine.onQuote(quote('2026-11-23T10:15:00', 12000));
  assert.equal(newDays.length, 1);
  assert.equal(stale.rvol, 1);
  stored.candles = [...HISTORY, ...session('2026-11-20', 800)];
  engine.reload(SYM);
  const fresh = engine.onQuote(quote('2026-11-23T10:15:30', 12000));
  assert.equal(fresh.baselineSessions, 3);
  assert.ok(fresh.rvol < 0.5);
  assert.equal(engine.detail(SYM).today[60], 12000);
});

test('engine: no history means no RVOL, not a crash', () => {
  const { engine } = engineWith([]);
  const row = engine.onQuote(quote('2026-11-20T10:15:00', 30000));
  assert.equal(row.rvol, null);
  assert.equal(row.baselineSessions, 0);
  assert.equal(row.ltp, 110);
});

test('server: page, snapshot, detail, 404s, and WebSocket snapshot + broadcast', async () => {
  const { engine } = engineWith(HISTORY);
  engine.onQuote(quote('2026-11-20T10:15:00', 30000));
  const dash = createDashboardServer({ engine, getStatus: () => ({ feed: 'connected' }) });
  await dash.listen(0);
  const base = `http://127.0.0.1:${dash.server.address().port}`;
  try {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Trading dashboard/);
    const snap = await (await fetch(base + '/api/snapshot')).json();
    assert.equal(snap.status.feed, 'connected');
    assert.equal(snap.rows[0].rvol, 2.5);
    const detail = await (await fetch(`${base}/api/detail?sym=${encodeURIComponent(SYM)}`)).json();
    assert.equal(detail.average.length, 375);
    assert.equal((await fetch(base + '/api/detail?sym=NOPE')).status, 404);
    assert.equal((await fetch(base + '/secret')).status, 404);
    assert.equal((await fetch(base + '/api/snapshot', { method: 'POST' })).status, 405);

    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    const [first] = await once(ws, 'message');
    assert.equal(JSON.parse(first).type, 'snapshot');
    const next = once(ws, 'message');
    dash.broadcast({ type: 'row', row: engine.onQuote(quote('2026-11-20T10:16:00', 36600)) });
    const msg = JSON.parse((await next)[0]);
    assert.equal(msg.row.rvol, 3);
    ws.close();
  } finally {
    await dash.close();
  }
});

test('engine: VWAP from the feed, deviation from it, and price/VWAP curves', () => {
  const today = session('2026-11-20', 500, 30).map((k, i) => ({ ...k, h: 100 + i, l: 100 + i, c: 100 + i }));
  const { engine } = engineWith([...HISTORY, ...today]);
  const row = engine.onQuote(quote('2026-11-20T10:15:00', 30000, { ltp: 110, vwap: 100 }));
  assert.equal(row.vwap, 100);
  assert.equal(row.vwapDevPct, 10);
  const d = engine.detail(SYM);
  assert.equal(d.price[0], 100);
  assert.equal(d.price[29], 129);
  assert.equal(d.vwapCurve[0], 100);
  assert.equal(d.vwapCurve[1], 100.5, 'candle VWAP is volume-weighted and cumulative');
  assert.equal(d.price[30], null);
  assert.equal(d.price[60], 110, 'live price lands on the current minute');
  assert.equal(d.vwapCurve[60], 100, 'live VWAP comes from the feed');
  const none = engine.onQuote(quote('2026-11-20T10:16:00', 30000, { ltp: 110, vwap: 0 }));
  assert.equal(none.vwap, null);
  assert.equal(none.vwapDevPct, null);
});

test('engine: VWAP deviation in ATRs uses ATR(14) on 5-minute candles', () => {
  // Every 1-minute candle spans 99..101, so every 5-minute candle has a true range of 2 -> ATR 2.
  const flat = (date) => session(date, 100).map((k) => ({ ...k, o: 100, h: 101, l: 99, c: 100 }));
  const { engine } = engineWith([...flat('2026-11-18'), ...flat('2026-11-19')]);
  const row = engine.onQuote(quote('2026-11-20T10:15:00', 30000, { ltp: 103, vwap: 100 }));
  assert.equal(row.atr5, 2);
  assert.equal(row.vwapDevAtr, 1.5);
  assert.equal(engine.onQuote(quote('2026-11-20T10:16:00', 30000, { ltp: 97, vwap: 100 })).vwapDevAtr, -1.5);
  const bare = engineWith([]).engine.onQuote(quote('2026-11-20T10:15:00', 1, { ltp: 103, vwap: 100 }));
  assert.equal(bare.atr5, null);
  assert.equal(bare.vwapDevAtr, null);
});

test('engine: true range, ATR %, relative ATR and their curves, on completed 5-minute candles only', () => {
  const shaped = (date, range, n = 375) => session(date, 100, n).map((k) => ({ ...k, o: 100, h: 100 + range / 2, l: 100 - range / 2, c: 100 }));
  // Two calm sessions (range 2), then today's first 27 minutes at double the range: 5 full candles + 2 minutes.
  const { engine } = engineWith([...shaped('2026-11-18', 2), ...shaped('2026-11-19', 2), ...shaped('2026-11-20', 4, 27)]);
  const row = engine.onQuote(quote('2026-11-20T09:42:10', 3000, { ltp: 200, vwap: 100 }));
  assert.equal(row.tr5, 4, 'last completed candle; the partial 09:40 candle is ignored');
  assert.ok(row.atr5 > 2 && row.atr5 < 4, 'ATR is rising from 2 towards 4');
  assert.equal(row.atrPct, (row.atr5 / 200) * 100);
  assert.ok(row.relAtr > 1.1, 'above its 100-candle average');
  const d = engine.detail(SYM);
  assert.equal(d.trCurve[0], 4);
  assert.equal(d.trCurve[1], null, 'one point per 5-minute candle');
  assert.equal(d.trCurve[20], 4);
  assert.equal(d.trCurve[25], null, 'no point for the partial candle');
  assert.equal(d.atrCurve[20], row.atr5);
});

test('engine: ROC and RSI on 5-minute closes, including the forming candle only during the session', () => {
  // Price rises 1 per 5-minute candle across two sessions: 150 candles closing 101..250.
  const rising = (date, base) => session(date, 100).map((k, i) => { const c = base + Math.floor(i / 5) + 1; return { ...k, o: c, h: c, l: c, c }; });
  const { engine } = engineWith([...rising('2026-11-18', 100), ...rising('2026-11-19', 175)]);
  // After the close: completed candles only. ROC(10) = 250 vs 240.
  const closed = engine.onQuote(quote('2026-11-19T15:59:00', 1, { ltp: 250 }));
  assert.ok(Math.abs(closed.roc - (10 / 240) * 100) < 1e-9);
  assert.equal(closed.rsi, 100);
  // Next morning, mid-session: the forming candle counts, with the live price as its close.
  const live = engine.onQuote(quote('2026-11-20T09:17:00', 1, { ltp: 225.9 }));
  assert.ok(Math.abs(live.roc - ((225.9 - 241) / 241) * 100) < 1e-9, 'live price vs the close 10 candles back');
  assert.ok(live.rsi < 50, 'a sharp drop pulls RSI down from 100');
  const d = engine.detail(SYM);
  assert.equal(d.rsiCurve.every((v) => v == null), true, 'no completed candles today yet');
  const none = engineWith([]).engine.onQuote(quote('2026-11-20T10:15:00', 1));
  assert.equal(none.roc, null);
  assert.equal(none.rsi, null);
});

test('engine: EMA(20), its slope % and price vs EMA', () => {
  const flat = (date) => session(date, 100).map((k) => ({ ...k, o: 100, h: 100, l: 100, c: 100 }));
  const { engine } = engineWith([...flat('2026-11-18'), ...flat('2026-11-19')]);
  const closed = engine.onQuote(quote('2026-11-19T15:59:00', 1, { ltp: 100 }));
  assert.equal(closed.ema, 100);
  assert.equal(closed.emaSlopePct, 0);
  assert.equal(closed.priceVsEmaPct, 0);
  // Live: a forming candle at 121 moves a 20-period EMA by 2/21 of the gap.
  const live = engine.onQuote(quote('2026-11-20T09:17:00', 1, { ltp: 121 }));
  assert.ok(Math.abs(live.ema - 102) < 1e-9);
  assert.ok(Math.abs(live.emaSlopePct - 2) < 1e-9, 'EMA now vs EMA 5 candles ago (100)');
  assert.ok(Math.abs(live.priceVsEmaPct - (19 / 102) * 100) < 1e-9);
  const d = engine.detail(SYM);
  assert.equal(d.emaCurve.length, 375);
  const none = engineWith([]).engine.onQuote(quote('2026-11-20T10:15:00', 1));
  assert.equal(none.ema, null);
  assert.equal(none.emaSlopePct, null);
});

test('engine: spread %, imbalance and depth from the order book', () => {
  const { engine } = engineWith(HISTORY);
  const live = ist('2026-11-20T10:15:00') * 1000;
  assert.equal(engine.row(SYM).book, null);
  engine.onQuote(quote('2026-11-20T10:15:00', 30000, { tbq: 9000, tsq: 3000 }));
  const row = engine.onDepth({ k: 'd5', sym: SYM, recv: live, bids: [[99.95, 300, 4], [99.9, 500, 6]], asks: [[100.05, 100, 2], [100.1, 100, 1]] });
  assert.ok(Math.abs(row.spread - 0.1) < 1e-9);
  assert.ok(Math.abs(row.spreadPct - 0.1) < 1e-9, '0.10 on a midpoint of 100');
  assert.equal(row.bidQty5, 800);
  assert.equal(row.askQty5, 200);
  assert.equal(row.imbalance5, 0.6);
  assert.equal(row.imbalanceBook, 0.5);
  assert.equal(row.bookLive, true);
  assert.deepEqual(row.book.bids[0], [99.95, 300, 4]);
  assert.equal(row.ltp, 110, 'quote fields are kept');
});

test('engine: one-sided or after-hours books give no spread and are flagged', () => {
  const { engine } = engineWith(HISTORY);
  const closed = engine.onDepth({ k: 'd5', sym: SYM, recv: ist('2026-11-20T07:15:00') * 1000, bids: [[1375.6, 5178, 29]], asks: [] });
  assert.equal(closed.bookLive, false);
  assert.equal(closed.spread, null);
  assert.equal(closed.spreadPct, null);
  assert.equal(closed.imbalance5, 1);
  assert.equal(closed.imbalanceBook, null);
  const empty = engine.onDepth({ k: 'd5', sym: SYM, recv: ist('2026-11-20T10:00:00') * 1000, bids: [], asks: [] });
  assert.equal(empty.imbalance5, null);
  assert.equal(engine.onDepth({ k: 'd5', sym: 'NSE:OTHER-EQ', recv: 1, bids: [], asks: [] }), null);
  assert.equal(engine.onDepth(quote('2026-11-20T10:00:00', 1)), null);
});

test('engine: pivot levels from the previous session and the levels around the price', () => {
  // Previous session (19 Nov): high 110, low 100, last candle close 104.
  const day = (date, h, l, c) => session(date, 100).map((k) => ({ ...k, o: c, h, l, c }));
  const { engine } = engineWith([...day('2026-11-18', 90, 80, 85), ...day('2026-11-19', 110, 100, 104)]);
  // The feed's official previous close (105) is used in place of the candle close (104).
  const row = engine.onQuote(quote('2026-11-20T10:15:00', 1, { ltp: 107, pc: 105 }));
  assert.deepEqual(row.prevDay, { h: 110, l: 100, c: 105 });
  const p = row.pivots;
  assert.deepEqual([p.s3, p.s2, p.s1, p.p, p.r1, p.r2, p.r3], [90, 95, 100, 105, 110, 115, 120]);
  assert.equal(row.support.name, 'Pivot');
  assert.equal(row.resistance.name, 'R1');
  assert.ok(Math.abs(row.resistance.distancePct - (3 / 107) * 100) < 1e-9);
  assert.ok(row.support.distancePct < 0);
  const high = engine.onQuote(quote('2026-11-20T10:16:00', 1, { ltp: 125, pc: 105 }));
  assert.equal(high.support.name, 'R3');
  assert.equal(high.resistance, null);
  const low = engine.onQuote(quote('2026-11-20T10:17:00', 1, { ltp: 80, pc: 105 }));
  assert.equal(low.support, null);
  assert.equal(low.resistance.name, 'S3');
  const exact = engine.onQuote(quote('2026-11-20T10:18:00', 1, { ltp: 110, pc: 105 }));
  assert.equal(exact.support.name, 'R1', 'a level the price sits on counts as support');
  const noPc = engine.onQuote(quote('2026-11-20T10:19:00', 1, { ltp: 107, pc: null }));
  assert.equal(noPc.prevDay.c, 104, 'falls back to the candle close');
  const none = engineWith([]).engine.onQuote(quote('2026-11-20T10:15:00', 1));
  assert.equal(none.pivots, null);
});

test('engine: last swing high and low from 5-candle swings on 5-minute candles', () => {
  // One session of 5-minute closes shaped as a zigzag; each 1-minute candle inside a bucket is flat.
  const shape = [100, 102, 104, 108, 104, 102, 98, 102, 104, 106, 104, 103, 101, 103, 104, 104, 104];
  const m1 = shape.flatMap((c, b) => Array.from({ length: 5 }, (_, j) => ({ t: ist('2026-11-19T09:15:00') + (b * 5 + j) * 60, o: c, h: c + 0.5, l: c - 0.5, c, v: 10 })));
  const { engine } = engineWith(m1);
  const row = engine.onQuote(quote('2026-11-19T15:59:00', 1, { ltp: 104 }));
  // Swing highs at 108.5 (09:30) and 106.5 (10:00); swing lows at 97.5 (09:45) and 100.5 (10:15).
  assert.deepEqual(row.swingHighs.map((x) => x.price), [108.5, 106.5]);
  assert.deepEqual(row.swingLows.map((x) => x.price), [97.5, 100.5]);
  assert.equal(row.swingHigh.price, 106.5);
  assert.equal(row.swingHigh.t, ist('2026-11-19T10:00:00'));
  assert.equal(row.swingHigh.broken, false);
  assert.ok(row.swingHigh.distancePct > 0);
  assert.equal(row.swingLow.price, 100.5);
  assert.equal(row.swingLow.broken, false);
  assert.equal(engine.onQuote(quote('2026-11-19T15:59:10', 1, { ltp: 107 })).swingHigh.broken, true);
  assert.equal(engine.onQuote(quote('2026-11-19T15:59:20', 1, { ltp: 100 })).swingLow.broken, true);
  const none = engineWith([]).engine.onQuote(quote('2026-11-20T10:15:00', 1));
  assert.equal(none.swingHigh, null);
  assert.deepEqual(none.swingLows, []);
});

test('engine: estimated order flow, shares, changes and CVD from quotes', () => {
  const { engine } = engineWith(HISTORY);
  // One snapshot every 5 s from 10:00 to 10:35: 75% of volume at the bid for 15 min, then 25%.
  let vol = 100000;
  const base = ist('2026-11-20T10:00:00');
  const send = (sec, o) => engine.onQuote({ k: 'q', sym: SYM, exch: (base + sec) * 1000, recv: (base + sec) * 1000 + 100, ltp: 100, ltq: 1, pc: 100, vol, bid: 99.95, ask: 100.05, tbq: 9000, tsq: 3000, ...o });
  send(-5, {});
  for (let sec = 0; sec < 35 * 60; sec += 5) {
    const sellPct = sec < 20 * 60 ? 75 : 25;
    vol += 50;
    send(sec, { ltp: ((sec / 5) % 12) * (100 / 12) < sellPct ? 99.95 : 100.05 });
  }
  const row = send(35 * 60, {});
  const f = row.flow;
  assert.equal(f.estimated, true);
  // recent window 10:20-10:35 (25% selling), previous 10:05-10:20 (75% selling)
  assert.equal(f.sellShare, 25);
  assert.equal(f.buyShare, 75);
  assert.equal(f.dominance, 'strong buying dominance');
  assert.ok(Math.abs(f.sellChangePct - (-200 / 3)) < 1e-9);
  assert.equal(f.buyChangePct, 200);
  assert.equal(f.totalChangePct, 0);
  assert.equal(f.sellChange, 'decreasing');
  assert.equal(f.buyChange, 'increasing');
  assert.equal(f.cvd, 20 * 60 / 5 * 50 * -0.5 + 15 * 60 / 5 * 50 * 0.5);
  assert.equal(f.cvdRate, 15 * 60 / 5 * 50 * 0.5);
  assert.equal(f.sessionUnclassifiedShare, 0);
  assert.equal(f.minutesUntilShare, 0);
  assert.equal(engine.detail(SYM).cvdCurve.length, 375);
  // whole-book quantity was constant, so both trends are flat
  assert.equal(row.askQtyTrend.label, 'flat');
  assert.equal(row.bidQtyTrend.pct, 0);
});

test('engine: flow is withheld until a full window is covered, and survives a restart via the store', () => {
  const saved = new Map();
  // Like FlowStore, but in memory: what is saved is the serialized form, as it would be on disk.
  const flowStore = {
    save: (sym, book) => saved.set(sym + book.day, JSON.stringify(book.toJSON())),
    load: (sym, day) => (saved.has(sym + day) ? FlowBook.fromJSON(JSON.parse(saved.get(sym + day))) : null),
  };
  const first = new RvolEngine({ symbols: [SYM], loadCandles: () => HISTORY, flowStore });
  let vol = 5000;
  const base = ist('2026-11-20T10:00:00');
  const send = (engine, sec, ltp) => engine.onQuote({ k: 'q', sym: SYM, exch: (base + sec) * 1000, recv: (base + sec) * 1000, ltp, ltq: 1, pc: 100, vol, bid: 99.95, ask: 100.05 });
  send(first, 0, 100);
  for (let sec = 5; sec <= 8 * 60; sec += 5) { vol += 10; send(first, sec, 100.05); }
  let f = first.row(SYM).flow;
  assert.equal(f.sellShare, null, 'only 8 minutes covered');
  assert.equal(f.minutesUntilShare, 7);
  assert.equal(f.cvd, 960);
  assert.equal(first.row(SYM).askQtyTrend.label, null, 'no book quantity samples');
  assert.equal(first.row(SYM).askQtyTrend.minutesUntil, 26, 'no samples before 10:08: at 10:34 the earlier window (10:05-10:19) has 12 sampled minutes');
  first.saveFlow();
  // a new process: same store, same session
  const second = new RvolEngine({ symbols: [SYM], loadCandles: () => HISTORY, flowStore });
  vol += 777; // traded while the server was down
  send(second, 9 * 60, 100.05);
  vol += 10;
  f = send(second, 9 * 60 + 1, 100.05).flow;
  assert.equal(f.cvd, 970, 'CVD carried over; downtime volume was not guessed');
  second.markFeedGap();
  vol += 500;
  f = send(second, 9 * 60 + 3, 100.05).flow;
  assert.equal(f.cvd, 970, 'volume across a reconnect stays unclassified');
  assert.ok(f.sessionUnclassifiedShare > 0);
});

test('engine: whole-book quantity samples are saved, so the ask / bid trend survives a restart', () => {
  const saved = new Map();
  const flowStore = {
    save: (sym, book) => saved.set(sym + book.day, JSON.stringify(book.toJSON())),
    load: (sym, day) => (saved.has(sym + day) ? FlowBook.fromJSON(JSON.parse(saved.get(sym + day))) : null),
  };
  const base = ist('2026-11-20T10:00:00');
  let vol = 5000;
  // sell quantity 1,000 for the first 15 minutes, 1,500 after; buy quantity constant
  const send = (engine, sec) => {
    vol += 10;
    return engine.onQuote({ k: 'q', sym: SYM, exch: (base + sec) * 1000, recv: (base + sec) * 1000, ltp: 100, ltq: 1, pc: 100, vol, bid: 99.95, ask: 100.05, tbq: 2000, tsq: sec < 15 * 60 ? 1000 : 1500 });
  };
  const first = new RvolEngine({ symbols: [SYM], loadCandles: () => HISTORY, flowStore });
  for (let sec = 0; sec < 29 * 60; sec += 20) send(first, sec);
  first.saveFlow();
  const second = new RvolEngine({ symbols: [SYM], loadCandles: () => HISTORY, flowStore });
  const row = send(second, 30 * 60); // back one minute later, at 10:30:00: windows are 10:15-10:30 and 10:00-10:15
  assert.equal(row.askQtyTrend.pct, 50);
  assert.equal(row.askQtyTrend.label, 'increasing');
  assert.equal(row.askQtyTrend.minutesUntil, 0);
  assert.equal(row.bidQtyTrend.label, 'flat');
  // the windows end at the current moment, so the value moves within a 5-minute candle
  const later = send(second, 32 * 60 + 30); // 10:32:30: the earlier window is now 10:02:30-10:17:30, part of it at 1,500
  assert.ok(later.askQtyTrend.pct < 50 && later.askQtyTrend.pct > 30, `got ${later.askQtyTrend.pct}`);
  // without the store the same quote has nothing to compare
  const fresh = new RvolEngine({ symbols: [SYM], loadCandles: () => HISTORY });
  assert.equal(send(fresh, 33 * 60).askQtyTrend.label, null);
});

test('engine: recent RVOL and both volume trends move with live quotes, joined to stored candles', () => {
  // Baseline 200 a minute. Stored today: 600 a minute for 15 minutes, then 100 a minute for 15 (09:15-09:45).
  const today = [...session('2026-11-20', 600, 15), ...session('2026-11-20', 100, 30).slice(15)];
  const { engine } = engineWith([...HISTORY, ...today]);
  // The feed's day total runs 1,000 above the candle total (pre-open trades), which must not leak into a window.
  let row = engine.onQuote(quote('2026-11-20T09:44:59', 10500 + 1000)); // the feed and the candles both cover minute 09:44
  // 09:50:00: 1,500 more shares since 09:45. Last 15 minutes = 09:35-09:50 = 1,000 from candles + 1,500 live.
  row = engine.onQuote(quote('2026-11-20T09:50:00', 10500 + 1000 + 1500));
  assert.equal(row.volumeWindowsLive, true);
  assert.equal(row.recentVolume, 2500);
  assert.ok(Math.abs(row.recentRvol - 2500 / 3000) < 1e-9);
  assert.equal(row.priorVolume, 6500, '09:20-09:35 from candles: 10 minutes at 600 and 5 at 100');
  assert.ok(Math.abs(row.rawVolumeTrendPct - ((2500 - 6500) / 6500) * 100) < 1e-9);
  assert.ok(Math.abs(row.volumeTrendPct - row.rawVolumeTrendPct) < 1e-9, 'flat baseline: both trends agree');
  assert.equal(row.volumeTrend, 'falling');
  // half a minute later with 300 more shares the values have moved, without waiting for a candle
  const next = engine.onQuote(quote('2026-11-20T09:50:30', 10500 + 1000 + 1800));
  assert.ok(next.recentVolume > row.recentVolume && next.recentVolume < 2800);
  // once the feed has covered both windows, candles are not needed at all
  const clock = (m, sec) => `2026-11-20T${String(9 + Math.floor((m + 15) / 60)).padStart(2, '0')}:${String((m + 15) % 60).padStart(2, '0')}:${sec}`; // m minutes after 09:15
  let vol = 13300;
  for (let m = 36; m <= 65; m++) {
    vol += 300; // 300 shares a minute, reported at the end of each minute
    engine.onQuote(quote(clock(m, '59'), vol));
  }
  row = engine.onQuote(quote(clock(66, '00'), vol)); // 10:21:00
  assert.equal(row.volumeWindowsLive, true);
  assert.equal(row.recentVolume, 4500);
  assert.equal(row.recentRvol, 1.5);
  assert.equal(row.volumeTrend, 'steady');
});

test('engine: recent RVOL and volume trend from completed candles', () => {
  // Baseline 200 a minute. Today: 600 a minute for 15 minutes, then 100 a minute for 15.
  const today = [...session('2026-11-20', 600, 15), ...session('2026-11-20', 100, 30).slice(15)];
  const { engine } = engineWith([...HISTORY, ...today]);
  const row = engine.onQuote(quote('2026-11-20T09:46:00', 12000));
  assert.equal(row.recentRvol, 0.5);
  assert.equal(row.priorRvol, 3);
  assert.ok(Math.abs(row.volumeTrendPct - (-250 / 3)) < 1e-9);
  assert.equal(row.volumeTrend, 'falling');
  // raw volume: 1,500 shares in the last 15 minutes against 9,000 in the 15 before
  assert.equal(row.recentVolume, 1500);
  assert.equal(row.priorVolume, 9000);
  assert.ok(Math.abs(row.rawVolumeTrendPct - (-250 / 3)) < 1e-9);
  const d = engine.detail(SYM);
  assert.equal(d.recentRvolCurve[14], 3);
  assert.equal(d.recentRvolCurve[29], 0.5);
  assert.equal(d.recentRvolCurve[20], null, 'one point per 5-minute boundary');
  const none = engineWith(HISTORY).engine.onQuote(quote('2026-11-20T09:46:00', 1));
  assert.equal(none.recentRvol, null);
  assert.equal(none.volumeTrend, null);
  assert.equal(none.rawVolumeTrendPct, null);
});
