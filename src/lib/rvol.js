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

/**
 * RVOL of one recent window: the volume traded in session minutes [end - minutes, end) divided
 * by the average volume of those same minutes over the baseline sessions. Unlike day RVOL this
 * shows what is happening now, not the whole day so far.
 * `todayCum` is today's cumulative curve from completed candles (null after the last stored minute).
 * Returns { volume, usual, rvol } or null when the window isn't fully available.
 */
export function windowRvol(todayCum, baseline, end, minutes) {
  const start = end - minutes;
  if (!baseline || !todayCum || start < 0 || end > SESSION_MINUTES) return null;
  const at = (curve, i) => (i < 0 ? 0 : curve[i]); // cumulative volume at the end of minute i
  const volume = at(todayCum, end - 1) == null || at(todayCum, start - 1) == null ? null : at(todayCum, end - 1) - at(todayCum, start - 1);
  const usual = at(baseline.curve, end - 1) - at(baseline.curve, start - 1);
  if (volume == null || !(usual > 0)) return null;
  return { volume, usual, rvol: volume / usual };
}

/**
 * Cumulative volume `t` minutes after the open, read from a per-minute curve where curve[k] is
 * the total at the end of minute k. Interpolated inside a minute. `fromZero`: the curve starts
 * from 0 at the open (candle totals do; the feed's running total may not). `maxGap`: how many
 * missing minutes may be bridged on each side. Null when the curve doesn't reach that moment.
 */
export function cumulativeAt(curve, t, { fromZero = false, maxGap = 0 } = {}) {
  if (!curve || !(t >= 0) || t > SESSION_MINUTES) return null;
  const at = (time) => (time === 0 ? (fromZero ? 0 : null) : (curve[time - 1] ?? null)); // total at a whole minute
  let lo = Math.floor(t);
  let hi = Math.ceil(t);
  for (let n = 0; at(lo) == null && lo > 0 && n < maxGap; n++) lo--;
  for (let n = 0; at(hi) == null && hi < SESSION_MINUTES && n < maxGap; n++) hi++;
  const a = at(lo);
  const b = at(hi);
  if (a == null || b == null) return null;
  return hi === lo ? a : a + ((t - lo) / (hi - lo)) * (b - a);
}

/**
 * Volume traded between `from` and `to` (minutes after the open), using the live feed where it
 * has been watching and stored candles before that.
 *   live:   the feed's running day total at the end of each minute (null where not watched)
 *   stored: cumulative volume from completed candles (null after the last stored minute)
 *   liveNow: { t, volume } the feed's total at the current moment, if `to` is now
 * The feed's total and the candle total differ by a constant (pre-open and block trades are in
 * one and not the other), so the two are never subtracted from each other directly: each side is
 * measured within one source, joined at a minute both sources cover.
 */
export function volumeBetween(live, stored, from, to, liveNow = null) {
  if (!(to > from)) return null;
  const liveAt = (t) => (liveNow && t === liveNow.t ? liveNow.volume : cumulativeAt(live, t, { maxGap: 3 }));
  const storedAt = (t) => cumulativeAt(stored, t, { fromZero: true });
  const lb = liveAt(to);
  const la = liveAt(from);
  if (la != null && lb != null) return lb - la;
  const sa = storedAt(from);
  const sb = storedAt(to);
  if (sa != null && sb != null) return sb - sa;
  if (lb == null || sa == null || !live || !stored) return null;
  // Older part from candles, newer part from the feed, joined at the latest minute both have.
  for (let j = Math.min(SESSION_MINUTES, Math.floor(to)) - 1; j + 1 >= from && j >= 0; j--) {
    if (live[j] != null && stored[j] != null) return lb - live[j] + (stored[j] - sa);
  }
  return null;
}

export { minuteIndex };
