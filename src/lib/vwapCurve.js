// Per-minute price and VWAP curves for one session, from stored 1-minute candles.
import { istDay, vwap } from './indicators.js';
import { minuteIndex, SESSION_MINUTES } from './rvol.js';

/** Returns { price, vwap }: arrays of SESSION_MINUTES values (null where there is no candle). */
export function sessionPriceCurves(m1, day) {
  const price = new Array(SESSION_MINUTES).fill(null);
  const vw = new Array(SESSION_MINUTES).fill(null);
  const today = m1.filter((k) => istDay(k.t) === day);
  const running = vwap(today);
  today.forEach((k, n) => {
    const i = minuteIndex(k.t);
    if (i < 0 || i >= SESSION_MINUTES) return;
    price[i] = k.c;
    vw[i] = running[n];
  });
  return { price, vwap: vw };
}

/** Distance of price from VWAP, in percent of VWAP. */
export const vwapDeviationPct = (price, vw) => (price != null && vw ? ((price - vw) / vw) * 100 : null);
