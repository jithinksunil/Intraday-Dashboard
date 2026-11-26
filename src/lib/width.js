// Width: how long price usually takes to make a move of a given size, in minutes.
//
//   Sideways width: from a starting price, the time for price to move 1 x ATR away (either way)
//                   and then come back to the starting price. Averaged over starts that were in a
//                   sideways market (flat EMA slope).
//   Momentum width: from a starting price, the time for price to move 2 x ATR (either way).
//                   Averaged over starts that were in a momentum market (clear EMA slope).
//
// Starts are the closes of completed 5-minute candles; the ATR is the 5-minute ATR(14) known at
// that close. Touches are found on 1-minute highs and lows. A move must finish in the same
// session; one still open at the close is not averaged in, but counts against how often the
// move happens. Pure functions; no I/O.
import { istDay } from './indicators.js';
import { minuteIndex, SESSION_MINUTES } from './rvol.js';

export const WIDTH_CONFIG = {
  reversionAtr: 1, // sideways: out by this many ATR, then back to the start
  momentumAtr: 2, // momentum: this many ATR in one direction
  flatSlope: 0.005, // |EMA slope % per candle| at or below this = sideways
  trendSlope: 0.02, // |EMA slope % per candle| at or above this = momentum
  sessions: 20, // earlier sessions averaged, plus today
};

/** 'sideways', 'momentum' or null (a weak slope, or not known), from the EMA slope in % per candle. */
export function regimeOf(slopePerCandle, cfg = WIDTH_CONFIG) {
  if (slopePerCandle == null || !Number.isFinite(slopePerCandle)) return null;
  const v = Math.abs(slopePerCandle);
  if (v <= cfg.flatSlope) return 'sideways';
  if (v >= cfg.trendSlope) return 'momentum';
  return null;
}

/**
 * From start time t0 (epoch s) and price p0, scans 1-minute candles m1[from..] of the same
 * session. Returns { reversion, momentum } widths in minutes (null if not completed that session).
 */
export function measureFrom(m1, from, t0, p0, atrValue, day, cfg = WIDTH_CONFIG) {
  const out = { reversion: null, momentum: null };
  if (!(atrValue > 0)) return out;
  const r = cfg.reversionAtr * atrValue;
  const m = cfg.momentumAtr * atrValue;
  let side = 0; // +1 went up 1 ATR first, -1 went down, 0 not yet
  for (let i = from; i < m1.length; i++) {
    const k = m1[i];
    if (istDay(k.t) !== day) break;
    const width = (k.t + 60 - t0) / 60; // to the end of this minute
    if (out.momentum == null && (k.h >= p0 + m || k.l <= p0 - m)) out.momentum = width;
    if (out.reversion == null) {
      if (side === 0) {
        if (k.h >= p0 + r) side = 1;
        else if (k.l <= p0 - r) side = -1;
        // the return is looked for from the next minute: inside one candle the order is unknown
      } else if ((side > 0 && k.l <= p0) || (side < 0 && k.h >= p0)) {
        out.reversion = width;
      }
    }
    if (out.momentum != null && out.reversion != null) break;
  }
  return out;
}

const summary = (widths, started) => {
  if (!started) return { avg: null, median: null, count: 0, started: 0, completionPct: null };
  const s = [...widths].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return {
    avg: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
    median: s.length ? (s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) : null,
    count: s.length,
    started,
    completionPct: (s.length / started) * 100,
  };
};

/**
 * m1:     1-minute candles, oldest first, spanning the sessions to measure
 * c5:     completed 5-minute candles over the same time, with atr5[] and slope[] (EMA slope % per
 *         candle) aligned to them
 * today:  IST day index of the current session
 * Returns {
 *   sideways, momentum: { avg, median, count, started, completionPct } for starts in that market,
 *   any:    the same two over every start, whatever the market,
 *   sessions: sessions that had at least one start,
 *   todayReversion, todayMomentum: per session minute, the width of the move that started at that
 *           minute today (null where none started or it did not finish),
 * }
 */
export function moveWidths(m1, c5, atr5, slope, today, cfg = WIDTH_CONFIG) {
  const days = [...new Set(c5.map((k) => istDay(k.t)))].filter((d) => d <= today).sort((a, b) => a - b);
  const keep = new Set([...days.filter((d) => d < today).slice(-cfg.sessions), today]);
  const acc = { sideways: [], momentum: [], anyRev: [], anyMom: [] };
  const started = { sideways: 0, momentum: 0, anyRev: 0, anyMom: 0 };
  const todayReversion = new Array(SESSION_MINUTES).fill(null);
  const todayMomentum = new Array(SESSION_MINUTES).fill(null);
  const seenDays = new Set();
  // While today's session is still running, a move from today that has not finished yet is
  // pending: it is left out of how often the move happens rather than counted as a miss.
  const lastToday = m1.findLast((k) => istDay(k.t) === today);
  const todayOpen = lastToday != null && minuteIndex(lastToday.t) < SESSION_MINUTES - 1;
  let j = 0;
  c5.forEach((k, n) => {
    const day = istDay(k.t);
    if (!keep.has(day) || !(atr5[n] > 0)) return;
    const t0 = k.t + 300; // the close of this 5-minute candle
    while (j < m1.length && m1[j].t < t0) j++;
    if (j >= m1.length || istDay(m1[j].t) !== day) return; // nothing left in this session
    seenDays.add(day);
    const w = measureFrom(m1, j, t0, k.c, atr5[n], day, cfg);
    const regime = regimeOf(slope[n], cfg);
    const pending = day === today && todayOpen;
    const count = (list, width) => {
      if (width != null) list.push(width);
      return width != null || !pending ? 1 : 0;
    };
    started.anyRev += count(acc.anyRev, w.reversion);
    started.anyMom += count(acc.anyMom, w.momentum);
    if (regime === 'sideways') started.sideways += count(acc.sideways, w.reversion);
    else if (regime === 'momentum') started.momentum += count(acc.momentum, w.momentum);
    if (day === today) {
      const i = Math.min(SESSION_MINUTES - 1, minuteIndex(t0));
      if (i >= 0) {
        todayReversion[i] = w.reversion;
        todayMomentum[i] = w.momentum;
      }
    }
  });
  return {
    sideways: summary(acc.sideways, started.sideways),
    momentum: summary(acc.momentum, started.momentum),
    any: { sideways: summary(acc.anyRev, started.anyRev), momentum: summary(acc.anyMom, started.anyMom) },
    sessions: seenDays.size,
    todayReversion,
    todayMomentum,
  };
}
