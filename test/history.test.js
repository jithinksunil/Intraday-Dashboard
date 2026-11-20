import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CandleStore } from '../src/lib/candleStore.js';
import {
  chunkRanges, FatalHistoryError, isComplete, parseCandles, parseResolution, rangeEnd, RateLimiter, syncSymbol,
} from '../src/lib/history.js';

const DAY = 86_400;
const ist = (s) => Date.parse(`${s}+05:30`) / 1000;

test('parseResolution accepts Fyers and folder spellings', () => {
  assert.equal(parseResolution('1'), '1m');
  assert.equal(parseResolution('15m'), '15m');
  assert.equal(parseResolution('D'), 'D');
  assert.equal(parseResolution('1D'), 'D');
  assert.throws(() => parseResolution('7'), /Unknown resolution/);
});

test('chunks cover the range exactly, without overlap, within the per-request cap', () => {
  const from = ist('2025-11-18T00:00:00');
  const to = ist('2026-11-18T12:00:00');
  for (const [res, capDays] of [['1m', 100], ['D', 366]]) {
    const chunks = chunkRanges(res, from, to);
    assert.equal(chunks[0][0], from);
    assert.equal(chunks.at(-1)[1], to);
    chunks.forEach(([a, b], i) => {
      assert.ok(b - a < capDays * DAY, `${res} chunk ${i} within ${capDays} days`);
      if (i) assert.equal(a, chunks[i - 1][1] + 1, 'contiguous, no overlap');
    });
  }
  assert.equal(chunkRanges('1m', from, to).length, 4);
  assert.equal(chunkRanges('D', from, to).length, 2);
});

test('only completed candles are kept', () => {
  const now = ist('2026-11-18T12:10:20');
  assert.equal(rangeEnd('1m', now), now - 60);
  assert.equal(isComplete('1m', ist('2026-11-18T12:09:00'), now), true);
  assert.equal(isComplete('1m', ist('2026-11-18T12:10:00'), now), false);
  assert.equal(isComplete('5m', ist('2026-11-18T12:05:00'), now), true);
  assert.equal(isComplete('5m', ist('2026-11-18T12:06:00'), now), false);
  // Daily candles are stamped 05:30 IST (00:00 UTC). Today's is final only after 15:45 IST.
  const todayCandle = ist('2026-11-18T05:30:00');
  assert.equal(isComplete('D', todayCandle, now), false);
  assert.equal(isComplete('D', todayCandle, ist('2026-11-18T15:46:00')), true);
  assert.equal(isComplete('D', ist('2026-11-17T05:30:00'), now), true);
  const rows = [[ist('2026-11-18T12:09:00'), 1, 2, 0.5, 1.5, 100], [ist('2026-11-18T12:10:00'), 1, 1, 1, 1, 5], 'junk'];
  assert.deepEqual(parseCandles('1m', rows, now), [{ t: ist('2026-11-18T12:09:00'), o: 1, h: 2, l: 0.5, c: 1.5, v: 100, oi: null }]);
});

function fakeClock(start = 0) {
  const clock = { t: start, slept: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.slept.push(ms);
    clock.t += ms;
  };
  return clock;
}

test('rate limiter never exceeds its per-minute or per-second limits', async () => {
  const clock = fakeClock(1_000_000);
  const limiter = new RateLimiter({ perMinute: 40, perSecond: 3, now: clock.now, sleep: clock.sleep });
  const times = [];
  for (let i = 0; i < 100; i++) {
    await limiter.take();
    times.push(clock.t);
  }
  for (let i = 0; i < times.length; i++) {
    assert.ok(times.filter((t) => t >= times[i] && t < times[i] + 60_000).length <= 40, 'per minute');
    assert.ok(times.filter((t) => t >= times[i] && t < times[i] + 1000).length <= 3, 'per second');
  }
});

// ---------- syncSymbol with a fake Fyers ----------
const NOW = ist('2026-11-18T12:00:30');
const SYM = 'NSE:SBIN-EQ';

/** Fake getHistory that serves 1-minute candles for 09:15-15:29 on every weekday. */
function fakeFyers(script = []) {
  const calls = [];
  const fn = async (p) => {
    calls.push(p);
    const scripted = script.shift();
    if (scripted) {
      if (scripted.reject) throw scripted.reject;
      return scripted;
    }
    const from = Number(p.range_from);
    const to = Number(p.range_to);
    const candles = [];
    for (let t = Math.ceil(from / 60) * 60; t <= to; t += 60) {
      const m = (((t + 19_800) % DAY) + DAY) % DAY / 60;
      const dow = new Date((t + 19_800) * 1000).getUTCDay();
      if (dow >= 1 && dow <= 5 && m >= 555 && m < 930) candles.push([t, 100, 101, 99, 100.5, 1000]);
    }
    return { s: candles.length ? 'ok' : 'no_data', candles };
  };
  fn.calls = calls;
  return fn;
}

const setup = (script) => {
  const clock = fakeClock(NOW * 1000);
  return {
    store: new CandleStore(mkdtempSync(join(tmpdir(), 'hist-'))),
    getHistory: fakeFyers(script),
    limiter: new RateLimiter({ now: clock.now, sleep: clock.sleep }),
    state: { requests: 0, rateLimitHits: 0 },
    clock,
  };
};

test('first sync fetches the lookback in chunks and stores only completed candles', async () => {
  const s = setup();
  const r = await syncSymbol({ ...s, symbol: SYM, res: '1m', fromSec: NOW - 5 * DAY, nowSec: NOW, sleep: s.clock.sleep });
  const stored = s.store.read(SYM, '1m');
  assert.equal(s.getHistory.calls.length, 1);
  assert.deepEqual(
    { resolution: s.getHistory.calls[0].resolution, date_format: s.getHistory.calls[0].date_format, range_to: s.getHistory.calls[0].range_to },
    { resolution: '1', date_format: '0', range_to: String(NOW - 60) },
  );
  // Window starts Fri 13 Nov 12:00:30 IST: Fri 12:01-15:29 (209 candles), Mon 16 and Tue 17
  // full sessions (375 each), Wed 18 09:15-11:59 (165). The weekend has none.
  assert.equal(stored.length, 209 + 2 * 375 + 165);
  assert.equal(stored.at(-1).t, ist('2026-11-18T11:59:00'));
  assert.equal(r.added, stored.length);
});

test('a second sync resumes from the last stored candle', async () => {
  const s = setup();
  await syncSymbol({ ...s, symbol: SYM, res: '1m', fromSec: NOW - 2 * DAY, nowSec: NOW, sleep: s.clock.sleep });
  const later = NOW + 10 * 60;
  const r = await syncSymbol({ ...s, symbol: SYM, res: '1m', fromSec: NOW - 2 * DAY, nowSec: later, sleep: s.clock.sleep });
  assert.equal(s.getHistory.calls[1].range_from, String(ist('2026-11-18T11:59:00')));
  assert.equal(r.added, 10);
  assert.equal(s.store.read(SYM, '1m').at(-1).t, ist('2026-11-18T12:09:00'));
});

test("Fyers' plan-limit wording counts as rate limiting, not a skipped range", async () => {
  const s = setup([{ s: 'error', code: 500, message: "You've reached the Standard plan limit of 50 requests/minute. Upgrade to Prime for higher API limits." }]);
  const r = await syncSymbol({ ...s, symbol: SYM, res: '1m', fromSec: NOW - DAY, nowSec: NOW, sleep: s.clock.sleep });
  assert.equal(s.state.rateLimitHits, 1);
  assert.equal(r.skippedChunks, 0);
});

test('one rate-limit response waits 65 s and retries; a second stops the run', async () => {
  const s = setup([{ s: 'error', code: -429, message: 'request limit reached' }]);
  await syncSymbol({ ...s, symbol: SYM, res: '1m', fromSec: NOW - DAY, nowSec: NOW, sleep: s.clock.sleep });
  assert.ok(s.clock.slept.includes(65_000));
  assert.equal(s.state.rateLimitHits, 1);
  assert.ok(s.store.read(SYM, '1m').length > 0, 'retry succeeded');

  s.getHistory = fakeFyers([{ s: 'error', code: -429, message: 'request limit reached' }]);
  await assert.rejects(
    syncSymbol({ ...s, symbol: 'NSE:TCS-EQ', res: '1m', fromSec: NOW - DAY, nowSec: NOW, sleep: s.clock.sleep }),
    (err) => err instanceof FatalHistoryError && /blocks your account/.test(err.message),
  );
});

test('an auth error stops the run with the login hint', async () => {
  const s = setup([{ reject: { s: 'error', code: -16, message: 'Could not authenticate the user' } }]);
  await assert.rejects(
    syncSymbol({ ...s, symbol: SYM, res: '1m', fromSec: NOW - DAY, nowSec: NOW, sleep: s.clock.sleep }),
    /npm run login/,
  );
});

test('network errors are retried; other errors skip just that range', async () => {
  const s = setup([{ reject: { s: 'error', code: 500, message: 'ECONNRESET' } }]);
  await syncSymbol({ ...s, symbol: SYM, res: '1m', fromSec: NOW - DAY, nowSec: NOW, sleep: s.clock.sleep });
  assert.equal(s.getHistory.calls.length, 2);
  assert.ok(s.store.read(SYM, '1m').length > 0);

  const t = setup([{ s: 'error', code: -50, message: 'Invalid symbol provided' }]);
  const logs = [];
  const r = await syncSymbol({ ...t, symbol: 'NSE:NOPE-EQ', res: '1m', fromSec: NOW - DAY, nowSec: NOW, sleep: t.clock.sleep, log: (m) => logs.push(m) });
  assert.equal(r.skippedChunks, 1);
  assert.equal(r.total, 0);
  assert.match(logs[0], /Invalid symbol/);
});

test('up-to-date series make no request', async () => {
  const s = setup();
  s.store.write(SYM, '1m', [{ t: NOW, o: 1, h: 1, l: 1, c: 1, v: 1, oi: null }]);
  const r = await syncSymbol({ ...s, symbol: SYM, res: '1m', fromSec: 0, nowSec: NOW, sleep: s.clock.sleep });
  assert.equal(s.getHistory.calls.length, 0);
  assert.equal(r.added, 0);
});
