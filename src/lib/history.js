// Planning and fetching Fyers historical candles, kept free of I/O so it can be unit-tested.
//
// Fyers limits (API docs, Plans & Limits, Standard plan):
//   - Data APIs: 5 requests/second, 50/minute, 5,000/day.
//   - Going over the per-minute limit more than 3 times in a day blocks the user for the rest
//     of the day, so the limiter stays well under it and the fetcher stops after a second 429.
//   - Up to 100 days per request for minute resolutions, 366 days for daily.
//   - Standard plan history: daily candles for the last 5 years, intraday for the last 1 year.

import { mergeCandles } from './candleStore.js';

const DAY_S = 86_400;

/** Our folder name -> { api: value Fyers expects, seconds per candle, maxDays per request }. */
export const RESOLUTIONS = {
  '1m': { api: '1', seconds: 60 },
  '2m': { api: '2', seconds: 120 },
  '3m': { api: '3', seconds: 180 },
  '5m': { api: '5', seconds: 300 },
  '10m': { api: '10', seconds: 600 },
  '15m': { api: '15', seconds: 900 },
  '20m': { api: '20', seconds: 1200 },
  '30m': { api: '30', seconds: 1800 },
  '45m': { api: '45', seconds: 2700 },
  '60m': { api: '60', seconds: 3600 },
  '120m': { api: '120', seconds: 7200 },
  '180m': { api: '180', seconds: 10800 },
  '240m': { api: '240', seconds: 14400 },
  D: { api: '1D', seconds: DAY_S, daily: true },
};
// One day under each documented cap, so a range counted inclusively can't overshoot.
const MAX_DAYS_INTRADAY = 99;
const MAX_DAYS_DAILY = 365;

/** Default lookback when nothing is stored yet: the most the Standard plan serves. */
export const DEFAULT_LOOKBACK_DAYS = { intraday: 365, daily: 5 * 365 };

/** Accepts "1", "1m", "5", "5m", "D", "1D". Returns the folder name, e.g. "1m" or "D". */
export function parseResolution(text) {
  const s = String(text).trim();
  if (s === 'D' || s === '1D') return 'D';
  const key = /^\d+$/.test(s) ? `${s}m` : s;
  if (!RESOLUTIONS[key]) {
    throw new Error(`Unknown resolution "${text}". Use one of: ${Object.keys(RESOLUTIONS).join(', ')}`);
  }
  return key;
}

const IST_OFFSET_S = 5.5 * 3600;
const istDayIndex = (t) => Math.floor((t + IST_OFFSET_S) / DAY_S);
const istSecondsIntoDay = (t) => (((t + IST_OFFSET_S) % DAY_S) + DAY_S) % DAY_S;
const DAILY_FINAL_AFTER_S = 15 * 3600 + 45 * 60; // a day's candle is final from 15:45 IST

/** True if the candle starting at `t` has finished as of `now` (epoch seconds). */
export function isComplete(res, t, now) {
  const r = RESOLUTIONS[res];
  if (!r.daily) return t + r.seconds <= now;
  const day = istDayIndex(t);
  const today = istDayIndex(now);
  return day < today || (day === today && istSecondsIntoDay(now) >= DAILY_FINAL_AFTER_S);
}

/**
 * Latest range_to that returns only completed candles. The docs say to end the range one
 * resolution before now; for daily that is simply now, and today's candle is filtered later.
 */
export function rangeEnd(res, now) {
  const r = RESOLUTIONS[res];
  return r.daily ? now : now - r.seconds;
}

/** Splits [from, to] (epoch seconds, inclusive) into request-sized, non-overlapping ranges. */
export function chunkRanges(res, from, to) {
  const span = (RESOLUTIONS[res].daily ? MAX_DAYS_DAILY : MAX_DAYS_INTRADAY) * DAY_S;
  const out = [];
  for (let a = from; a <= to; a += span) out.push([a, Math.min(a + span - 1, to)]);
  return out;
}

/** Fyers candle arrays -> objects, keeping only completed candles. */
export function parseCandles(res, rows, now) {
  return (rows ?? [])
    .filter((r) => Array.isArray(r) && r.length >= 6 && isComplete(res, r[0], now))
    .map(([t, o, h, l, c, v, oi]) => ({ t, o, h, l, c, v, oi: oi ?? null }));
}

/** Sliding-window limiter: at most `perMinute` calls in any 60 s and `perSecond` in any 1 s. */
export class RateLimiter {
  constructor({ perMinute = 40, perSecond = 3, now = Date.now, sleep = defaultSleep } = {}) {
    this.perMinute = perMinute;
    this.perSecond = perSecond;
    this.now = now;
    this.sleep = sleep;
    this.calls = [];
  }

  async take() {
    for (;;) {
      const t = this.now();
      this.calls = this.calls.filter((c) => t - c < 60_000);
      const lastSecond = this.calls.filter((c) => t - c < 1000);
      let waitMs = 0;
      if (this.calls.length >= this.perMinute) waitMs = 60_000 - (t - this.calls[0]) + 50;
      else if (lastSecond.length >= this.perSecond) waitMs = 1000 - (t - lastSecond[0]) + 10;
      if (waitMs <= 0) {
        this.calls.push(t);
        return;
      }
      await this.sleep(waitMs);
    }
  }
}

export const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FatalHistoryError extends Error {}

const isRateLimited = (r) => r?.code === -429 || r?.code === 429 || /rate limit|too many requests/i.test(r?.message ?? '');
// Matched on the message: Fyers' numeric auth error codes aren't documented clearly enough to rely on.
const isAuthError = (r) => [401, 403].includes(r?.code) || /token|unauthori[sz]ed|authenticat/i.test(r?.message ?? '');
const isNetworkError = (r) => typeof r?.message === 'string' && /^E[A-Z]+$/.test(r.message); // ECONNRESET, ETIMEDOUT, ...

/**
 * Brings one symbol/resolution up to date. `getHistory(params)` resolves or rejects with the
 * Fyers response body. Starts from the last stored candle (re-fetching it, in case it was
 * corrected) or `fromSec` if nothing is stored. Returns a summary; throws FatalHistoryError
 * when continuing would be unsafe (bad token, repeated rate limiting).
 */
export async function syncSymbol({
  getHistory, store, symbol, res, fromSec, nowSec, limiter, state, log = () => {}, sleep = defaultSleep,
}) {
  const existing = store.read(symbol, res);
  const start = existing.length ? existing.at(-1).t : fromSec;
  const end = rangeEnd(res, nowSec);
  if (start > end) return { symbol, res, added: 0, total: existing.length, skippedChunks: 0 };

  let fetched = [];
  let skippedChunks = 0;
  for (const [a, b] of chunkRanges(res, start, end)) {
    const params = {
      symbol, resolution: RESOLUTIONS[res].api, date_format: '0', range_from: String(a), range_to: String(b), cont_flag: '1',
    };
    let networkTries = 0;
    for (;;) {
      await limiter.take();
      state.requests++;
      let r;
      try {
        r = await getHistory(params);
      } catch (err) {
        r = err;
      }
      if (r?.s === 'ok' || r?.s === 'no_data') {
        fetched = fetched.concat(parseCandles(res, r.candles, nowSec));
        break;
      }
      if (isRateLimited(r)) {
        state.rateLimitHits++;
        if (state.rateLimitHits >= 2) {
          throw new FatalHistoryError(
            'Fyers rate-limited this run twice. Stopping: a third per-minute overage blocks your account ' +
              'for the rest of the day. Wait a few minutes and rerun; stored candles are kept and it resumes.',
          );
        }
        log(`rate limited on ${symbol} ${res}; waiting 65 s before retrying`);
        await sleep(65_000);
        continue;
      }
      if (isAuthError(r)) {
        throw new FatalHistoryError(`Fyers rejected the token (${r?.message ?? r?.code}). Run: npm run login`);
      }
      if (isNetworkError(r) && networkTries < 3) {
        networkTries++;
        await sleep(2000 * 2 ** (networkTries - 1));
        continue;
      }
      skippedChunks++;
      log(`skipped ${symbol} ${res} ${new Date(a * 1000).toISOString().slice(0, 10)}..: ${r?.message || r?.code || 'unknown error'}`);
      break;
    }
  }

  const merged = mergeCandles(existing, fetched);
  if (fetched.length) store.write(symbol, res, merged);
  return { symbol, res, added: merged.length - existing.length, total: merged.length, skippedChunks };
}
