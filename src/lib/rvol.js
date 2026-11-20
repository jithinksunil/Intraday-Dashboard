// Real-time RVOL: today's cumulative volume divided by the average cumulative volume at the
// same time of day over the previous sessions. Pure functions.
import { istDay, istSecOfDay, SESSION_OPEN_S, sessions } from './indicators.js';

export const SESSION_MINUTES = 375; // 09:15 to 15:30 IST
const MIN_SESSION_CANDLES = 300; // shorter sessions (e.g. Muhurat trading) are left out of the average

const minuteIndex = (t) => Math.floor((istSecOfDay(t) - SESSION_OPEN_S) / 60);

/** Cumulative volume at the end of each session minute (index 0 = the 09:15 candle). */
export function cumulativeCurve(dayCandles) {
  const perMinute = new Array(SESSION_MINUTES).fill(0);
  for (const k of dayCandles) {
    const i = minuteIndex(k.t);
    if (i >= 0 && i < SESSION_MINUTES) perMinute[i] += k.v;
  }
  let sum = 0;
  return perMinute.map((v) => (sum += v));
}

/**
 * Average cumulative-volume curve over the last `lookback` full sessions before `day`
 * (an IST day index). Returns { curve, sessions } or null if there is no usable history.
 */
export function buildBaseline(m1, day, lookback = 20) {
  const prior = sessions(m1)
    .filter((s) => istDay(s[0].t) < day && s.length >= MIN_SESSION_CANDLES)
    .slice(-lookback);
  if (!prior.length) return null;
  const curves = prior.map(cumulativeCurve);
  const curve = Array.from({ length: SESSION_MINUTES }, (_, i) => curves.reduce((s, c) => s + c[i], 0) / curves.length);
  return { curve, sessions: prior.length, day };
}

/** Today's cumulative curve from stored candles, up to the last stored minute (null after it). */
export function todayCurve(m1, day) {
  const today = m1.filter((k) => istDay(k.t) === day);
  if (!today.length) return new Array(SESSION_MINUTES).fill(null);
  const lastIdx = Math.min(SESSION_MINUTES - 1, minuteIndex(today[today.length - 1].t));
  return cumulativeCurve(today).map((v, i) => (i <= lastIdx ? v : null));
}

/**
 * Average volume expected by time `tSec` (epoch seconds), interpolated within the minute.
 * Null before the open; the full-day average at or after the close.
 */
export function expectedVolume(baseline, tSec) {
  const elapsedMin = (istSecOfDay(tSec) - SESSION_OPEN_S) / 60;
  if (elapsedMin <= 0) return null;
  if (elapsedMin >= SESSION_MINUTES) return baseline.curve[SESSION_MINUTES - 1];
  const i = Math.floor(elapsedMin);
  const before = i === 0 ? 0 : baseline.curve[i - 1];
  return before + (elapsedMin - i) * (baseline.curve[i] - before);
}

/** RVOL at `tSec` given the day's volume so far. Null when it can't be computed yet. */
export function rvolAt(baseline, volume, tSec) {
  if (!baseline || volume == null) return null;
  const expected = expectedVolume(baseline, tSec);
  return expected > 0 ? { rvol: volume / expected, expected } : null;
}

export { minuteIndex };
