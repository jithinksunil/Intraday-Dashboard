// Indicator maths on candle arrays ({ t, o, h, l, c, v }, t = candle start in epoch seconds).
// Pure functions, no I/O. Series functions return an array aligned with the input, with null
// where there isn't enough history yet. Periods are conventional defaults, not tested settings.

const IST_OFFSET_S = 19_800;
const DAY_S = 86_400;
export const SESSION_OPEN_S = 9 * 3600 + 15 * 60;

export const istDay = (t) => Math.floor((t + IST_OFFSET_S) / DAY_S);
export const istSecOfDay = (t) => (((t + IST_OFFSET_S) % DAY_S) + DAY_S) % DAY_S;
export const last = (xs) => (xs.length ? xs[xs.length - 1] : null);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// ---------- reshaping ----------

/** 1-minute candles -> n-minute candles, buckets anchored at the 09:15 IST open. */
export function resample(candles, minutes) {
  const span = minutes * 60;
  const out = [];
  for (const k of candles) {
    const off = (((istSecOfDay(k.t) - SESSION_OPEN_S) % span) + span) % span;
    const t = k.t - off;
    const cur = out[out.length - 1];
    if (cur && cur.t === t) {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
      cur.v += k.v;
    } else {
      out.push({ t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
    }
  }
  return out;
}

/** Intraday candles -> one candle per IST day (t = first candle of that day). */
export function toDaily(candles) {
  const out = [];
  let day = null;
  for (const k of candles) {
    const d = istDay(k.t);
    if (d !== day) {
      out.push({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
      day = d;
    } else {
      const cur = out[out.length - 1];
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
      cur.v += k.v;
    }
  }
  return out;
}

/** Candles grouped into sessions: [[day1 candles], [day2 candles], ...]. */
export function sessions(candles) {
  const out = [];
  let day = null;
  for (const k of candles) {
    const d = istDay(k.t);
    if (d !== day) {
      out.push([]);
      day = d;
    }
    out[out.length - 1].push(k);
  }
  return out;
}

// ---------- moving averages and momentum ----------

export function sma(xs, n) {
  const out = new Array(xs.length).fill(null);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    if (i >= n) sum -= xs[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** EMA seeded with the SMA of the first n values. */
export function ema(xs, n) {
  const out = new Array(xs.length).fill(null);
  if (xs.length < n) return out;
  const a = 2 / (n + 1);
  let e = mean(xs.slice(0, n));
  out[n - 1] = e;
  for (let i = n; i < xs.length; i++) {
    e = xs[i] * a + e * (1 - a);
    out[i] = e;
  }
  return out;
}

/** Percent change of a series over `bars` bars (used for EMA slope % and ROC). */
export function pctChange(xs, bars) {
  return xs.map((x, i) => (i >= bars && x != null && xs[i - bars] != null && xs[i - bars] !== 0 ? ((x - xs[i - bars]) / xs[i - bars]) * 100 : null));
}
export const roc = (closes, n = 10) => pctChange(closes, n);

/** RSI with Wilder smoothing. */
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = value();
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = value();
  }
  return out;
}

/** MACD line, signal line and histogram. */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const start = line.findIndex((x) => x != null);
  const sig = new Array(closes.length).fill(null);
  if (start >= 0) ema(line.slice(start), signal).forEach((x, i) => (sig[start + i] = x));
  return { line, signal: sig, hist: line.map((x, i) => (x != null && sig[i] != null ? x - sig[i] : null)) };
}

/** Bollinger Bands (population standard deviation). widthPct = band width / middle; pctB = position within the bands. */
export function bollinger(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const upper = [];
  const lower = [];
  const widthPct = [];
  const pctB = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) {
      upper.push(null), lower.push(null), widthPct.push(null), pctB.push(null);
      continue;
    }
    const win = closes.slice(i + 1 - n, i + 1);
    const sd = Math.sqrt(mean(win.map((x) => (x - mid[i]) ** 2)));
    const u = mid[i] + k * sd;
    const l = mid[i] - k * sd;
    upper.push(u), lower.push(l);
    widthPct.push(((u - l) / mid[i]) * 100);
    pctB.push(u === l ? 0.5 : (closes[i] - l) / (u - l));
  }
  return { mid, upper, lower, widthPct, pctB };
}

// ---------- volatility and trend strength ----------

export function trueRanges(candles) {
  return candles.map((k, i) => (i === 0 ? k.h - k.l : Math.max(k.h - k.l, Math.abs(k.h - candles[i - 1].c), Math.abs(k.l - candles[i - 1].c))));
}

function wilder(xs, n) {
  const out = new Array(xs.length).fill(null);
  if (xs.length < n) return out;
  let v = mean(xs.slice(0, n));
  out[n - 1] = v;
  for (let i = n; i < xs.length; i++) {
    v = (v * (n - 1) + xs[i]) / n;
    out[i] = v;
  }
  return out;
}

/** ATR with Wilder smoothing. */
export const atr = (candles, n = 14) => wilder(trueRanges(candles), n);

/** Current ATR divided by its own average over the previous `lookback` bars (1 = normal). */
export function relativeAtr(atrSeries, lookback = 100) {
  const vals = atrSeries.filter((x) => x != null);
  if (vals.length < 2) return null;
  const prior = vals.slice(-lookback - 1, -1);
  return last(vals) / mean(prior);
}

/** ADX with +DI and -DI (Wilder). */
export function adx(candles, n = 14) {
  const len = candles.length;
  const out = { adx: new Array(len).fill(null), plusDI: new Array(len).fill(null), minusDI: new Array(len).fill(null) };
  if (len < 2 * n) return out;
  const tr = trueRanges(candles);
  let trS = 0;
  let pS = 0;
  let mS = 0;
  const dx = [];
  for (let i = 1; i < len; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    const p = up > down && up > 0 ? up : 0;
    const m = down > up && down > 0 ? down : 0;
    if (i <= n) {
      trS += tr[i];
      pS += p;
      mS += m;
      if (i < n) continue;
    } else {
      trS = trS - trS / n + tr[i];
      pS = pS - pS / n + p;
      mS = mS - mS / n + m;
    }
    const pdi = trS === 0 ? 0 : (100 * pS) / trS;
    const mdi = trS === 0 ? 0 : (100 * mS) / trS;
    out.plusDI[i] = pdi;
    out.minusDI[i] = mdi;
    dx.push({ i, v: pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi) });
  }
  wilder(dx.map((d) => d.v), n).forEach((v, j) => (out.adx[dx[j].i] = v));
  return out;
}

/** Chandelier Exit levels: highest high - k*ATR for longs, lowest low + k*ATR for shorts. */
export function chandelier(candles, n = 22, k = 3) {
  const a = atr(candles, n);
  return candles.map((_, i) => {
    if (a[i] == null || i < n - 1) return null;
    const win = candles.slice(i + 1 - n, i + 1);
    return { long: Math.max(...win.map((c) => c.h)) - k * a[i], short: Math.min(...win.map((c) => c.l)) + k * a[i] };
  });
}

// ---------- VWAP, levels, volume ----------

const typical = (k) => (k.h + k.l + k.c) / 3;

/** VWAP from the first candle given (pass one session for session VWAP, or candles from an anchor for anchored VWAP). */
export function vwap(candles) {
  let pv = 0;
  let v = 0;
  return candles.map((k) => {
    pv += typical(k) * k.v;
    v += k.v;
    return v ? pv / v : null;
  });
}
export const anchoredVwap = (candles, anchorT) => last(vwap(candles.filter((k) => k.t >= anchorT)));

/** Classic floor pivots from the previous session's high, low and close. */
export function pivots(prev) {
  const p = (prev.h + prev.l + prev.c) / 3;
  const range = prev.h - prev.l;
  return { p, r1: 2 * p - prev.l, s1: 2 * p - prev.h, r2: p + range, s2: p - range, r3: prev.h + 2 * (p - prev.l), s3: prev.l - 2 * (prev.h - p) };
}

/**
 * Swing highs/lows: a bar whose high (low) is the extreme of `wing` bars on each side.
 * Ties are settled so a flat stretch gives at most one swing: the bar must be strictly beyond
 * every bar before it in the window, not beaten by any bar after it, and strictly beyond at
 * least one bar after it (so a rise into a plateau is not a swing until price turns).
 */
export function swings(candles, wing = 3) {
  const highs = [];
  const lows = [];
  const isSwing = (i, get, beyond) => {
    const v = get(candles[i]);
    const before = candles.slice(i - wing, i).map(get);
    const after = candles.slice(i + 1, i + wing + 1).map(get);
    return before.every((x) => beyond(v, x)) && after.every((x) => !beyond(x, v)) && after.some((x) => beyond(v, x));
  };
  for (let i = wing; i < candles.length - wing; i++) {
    if (isSwing(i, (c) => c.h, (a, b) => a > b)) highs.push({ t: candles[i].t, price: candles[i].h });
    if (isSwing(i, (c) => c.l, (a, b) => a < b)) lows.push({ t: candles[i].t, price: candles[i].l });
  }
  return { highs, lows };
}

/** Nearest swing low below and swing high above `price`. */
export function nearestLevels(candles, price, wing = 3) {
  const { highs, lows } = swings(candles, wing);
  const below = lows.map((s) => s.price).filter((p) => p < price);
  const above = highs.map((s) => s.price).filter((p) => p > price);
  return { support: below.length ? Math.max(...below) : null, resistance: above.length ? Math.min(...above) : null };
}

/**
 * Volume profile from candles: each candle's volume goes to its typical price, in bins of
 * `bin` rupees. Returns POC and the value area holding `share` of the volume. An approximation:
 * candles don't say at which prices inside the bar the volume actually traded.
 */
export function volumeProfile(candles, bin, share = 0.7) {
  const vol = new Map();
  let total = 0;
  for (const k of candles) {
    if (!k.v) continue;
    const b = Math.round(typical(k) / bin);
    vol.set(b, (vol.get(b) ?? 0) + k.v);
    total += k.v;
  }
  if (!total) return null;
  let poc = null;
  for (const [b, v] of vol) if (poc == null || v > vol.get(poc)) poc = b;
  const keys = [...vol.keys()];
  const min = Math.min(...keys);
  const max = Math.max(...keys);
  let lo = poc;
  let hi = poc;
  let acc = vol.get(poc);
  while (acc < share * total && (lo > min || hi < max)) {
    const down = lo > min ? (vol.get(lo - 1) ?? 0) : -1;
    const up = hi < max ? (vol.get(hi + 1) ?? 0) : -1;
    if (up >= down) acc += vol.get(++hi) ?? 0;
    else acc += vol.get(--lo) ?? 0;
  }
  return { poc: poc * bin, vah: hi * bin, val: lo * bin };
}

/**
 * Relative volume by time of day: the latest session's volume up to its last candle, divided by
 * the average volume up to the same clock time over the previous `lookback` sessions.
 */
export function rvol(candles, lookback = 20) {
  const days = sessions(candles);
  if (days.length < 2) return null;
  const today = days[days.length - 1];
  const cutoff = istSecOfDay(last(today).t);
  const upTo = (day) => day.filter((k) => istSecOfDay(k.t) <= cutoff).reduce((s, k) => s + k.v, 0);
  const prior = days.slice(-lookback - 1, -1).map(upTo).filter((v) => v > 0);
  const now = upTo(today);
  return prior.length && now ? now / mean(prior) : null;
}

/** Percent return over the last `bars` bars. */
export function returnPct(candles, bars) {
  if (candles.length <= bars) return null;
  const base = candles[candles.length - 1 - bars].c;
  return base ? ((last(candles).c - base) / base) * 100 : null;
}

/** Pearson correlation of two return series (same length). */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
