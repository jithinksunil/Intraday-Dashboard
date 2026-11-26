// Estimated order flow: how much of the traded volume was buyer- or seller-initiated.
//
// The Fyers data socket has no trade-by-trade feed. It sends a snapshot about once a second with
// the last traded price, cumulative day volume and best bid/ask. So volume is classified per
// snapshot interval, not per trade: the volume traded between two snapshots is given one label
// from where the last price sits against the quote that was in force before it (quote rule),
// falling back to the direction of the price change (tick rule). Volume that can't be labelled
// is counted as unclassified, never assigned to a side. Everything derived here is an ESTIMATE.
//
// Pure functions and a small state holder; no I/O.
import { istDay } from './indicators.js';
import { minuteIndex, SESSION_MINUTES } from './rvol.js';

export const DEFAULT_FLOW_CONFIG = {
  candleMinutes: 5,
  windowCandles: 3, // 3 completed 5-minute candles = a 15-minute window
  // The feed sends a snapshot only when something changes: measured live, 0.3 to 2.3 a second per
  // stock, and up to ~16 s between trades on a quiet one. So silence alone is not a fault, and
  // these limits are deliberately loose; a real reconnect is flagged with FlowBook.markGap().
  maxQuoteAgeMs: 30_000, // an older previous quote is not trusted for the quote rule
  maxGapMs: 60_000, // a longer silence leaves that interval's volume unclassified
  share: { strongSell: 60, sell: 55, buy: 45, strongBuy: 40 }, // sell-share bands, in percent
  changePct: 20, // beyond +/- this, a volume change counts as increasing / decreasing
  cvdTrendCandles: 6, // CVD trend is fitted over this many completed candles (30 minutes)
  cvdTrendMinSlope: 0.05, // net buying per candle, as a share of average candle volume, to count as a trend
};

/**
 * Labels the volume traded between two snapshots.
 * prev / cur: { vol, ltp, ltq, bid, ask, at } where `at` is the local receive time in ms.
 * prev.dir is the last known trade direction (+1 buy, -1 sell, 0 unknown).
 * Returns { buy, sell, unclassified, dir, multi, why }.
 */
export function classifyInterval(prev, cur, cfg = DEFAULT_FLOW_CONFIG) {
  const none = { buy: 0, sell: 0, unclassified: 0, dir: prev?.dir ?? 0, multi: 0, why: 'no volume' };
  if (!prev || cur.vol == null || prev.vol == null) return none;
  const volume = cur.vol - prev.vol;
  if (!(volume > 0)) return none; // duplicate or out-of-order snapshot

  const out = (side, why, dir) => ({
    buy: side === 'buy' ? volume : 0,
    sell: side === 'sell' ? volume : 0,
    unclassified: side == null ? volume : 0,
    dir: dir ?? (side === 'buy' ? 1 : side === 'sell' ? -1 : prev.dir ?? 0),
    // More volume than the last trade's quantity means several trades share this one label.
    multi: cur.ltq != null && volume > cur.ltq ? volume : 0,
    why,
  });

  const gap = cur.at - prev.at;
  if (!(gap <= cfg.maxGapMs)) return out(null, 'gap');
  if (cur.ltp == null) return out(null, 'no price');

  const quoteOk = prev.bid > 0 && prev.ask > 0 && prev.ask > prev.bid && gap <= cfg.maxQuoteAgeMs;
  if (quoteOk) {
    if (cur.ltp >= prev.ask) return out('buy', 'at ask');
    if (cur.ltp <= prev.bid) return out('sell', 'at bid');
    const mid = (prev.ask + prev.bid) / 2;
    if (cur.ltp > mid) return out('buy', 'above mid');
    if (cur.ltp < mid) return out('sell', 'below mid');
  }
  // Tick rule: direction of the price change, or the last known direction if unchanged.
  if (prev.ltp != null) {
    if (cur.ltp > prev.ltp) return out('buy', 'uptick');
    if (cur.ltp < prev.ltp) return out('sell', 'downtick');
    if (prev.dir > 0) return out('buy', 'zero-uptick');
    if (prev.dir < 0) return out('sell', 'zero-downtick');
  }
  return out(null, quoteOk ? 'no direction' : 'no usable quote');
}

const emptyBucket = () => ({ b: 0, s: 0, u: 0, m: 0 });

/** Per-stock, per-session store of classified volume in one-minute buckets. */
export class FlowBook {
  constructor(cfg = DEFAULT_FLOW_CONFIG) {
    this.cfg = cfg;
    this.reset(null);
  }

  reset(day) {
    this.day = day;
    this.prev = null;
    this.gapPending = false;
    this.resumed = false;
    this.buckets = new Array(SESSION_MINUTES).fill(null); // { b, s, u, m } per session minute
    this.seen = new Array(SESSION_MINUTES).fill(false); // a snapshot arrived during this minute
    this.broken = new Array(SESSION_MINUTES).fill(false); // a reconnect gap ended in this minute
    this.bookQty = new Array(SESSION_MINUTES).fill(null); // { buy, sell, n }: sums of whole-book quantity samples
    this.depth = new Array(SESSION_MINUTES).fill(null); // { sp, sn, im, imn }: sums of spread % and top-5 imbalance samples
    this.stats = { buy: 0, sell: 0, unclassified: 0, multi: 0, why: {} };
  }

  /** Adds one sample of the spread % and the top-5 imbalance for a session minute (either may be null). */
  addDepth(idx, spreadPct, imbalance5) {
    if (!(idx >= 0 && idx < SESSION_MINUTES)) return;
    const okSp = Number.isFinite(spreadPct);
    const okIm = Number.isFinite(imbalance5);
    if (!okSp && !okIm) return;
    const k = (this.depth[idx] ??= { sp: 0, sn: 0, im: 0, imn: 0 });
    if (okSp) {
      k.sp += spreadPct;
      k.sn++;
    }
    if (okIm) {
      k.im += imbalance5;
      k.imn++;
    }
  }

  /** Adds one sample of the whole book's total buy and sell quantity for a session minute. */
  addBookQty(idx, buy, sell) {
    if (!(idx >= 0 && idx < SESSION_MINUTES) || !Number.isFinite(buy) || !Number.isFinite(sell)) return;
    const k = (this.bookQty[idx] ??= { buy: 0, sell: 0, n: 0 });
    k.buy += buy;
    k.sell += sell;
    k.n++;
  }

  /** Call when the feed reconnects: the next interval's volume was not observed, so it stays unclassified. */
  markGap() {
    this.gapPending = true;
  }

  /** Applies one normalized quote record. Returns the classification, or null if nothing was added. */
  onQuote(q) {
    const tMs = q.exch ?? q.recv;
    const tSec = Math.floor(tMs / 1000);
    const day = istDay(tSec);
    if (day !== this.day) this.reset(day); // new trading session: CVD and buckets start again
    const idx = minuteIndex(tSec);
    const inSession = idx >= 0 && idx < SESSION_MINUTES;
    const snap = { vol: q.vol, ltp: q.ltp, ltq: q.ltq, bid: q.bid, ask: q.ask, at: q.recv, dir: this.prev?.dir ?? 0, inSession };
    if (snap.vol == null) return null;
    // Out of order or a repeat: keep the newer state, only refresh the quote on an exact repeat.
    if (this.prev && snap.vol < this.prev.vol) return null;
    if (this.prev && snap.vol === this.prev.vol) {
      Object.assign(this.prev, { bid: snap.bid, ask: snap.ask, at: snap.at });
      if (inSession) this.seen[idx] = true;
      return null;
    }
    // The first snapshot of a session, and anything outside 09:15-15:30, only sets the baseline.
    if (!this.prev || !inSession) {
      // Resuming a saved session: trades during the downtime were not seen, so this minute is not fully covered.
      if (!this.prev && this.resumed && inSession) this.broken[idx] = true;
      this.resumed = false;
      this.prev = snap;
      this.gapPending = false;
      if (inSession) this.seen[idx] = true;
      return null;
    }
    let c = classifyInterval(this.prev, snap, this.cfg);
    const volume = c.buy + c.sell + c.unclassified;
    const unknown = (why) => ({ buy: 0, sell: 0, unclassified: volume, dir: 0, multi: c.multi, why });
    // The interval that spans the open starts from a pre-open snapshot: its volume is the first
    // trades of the session, but the quote before them was not a live one. Unclassified, not a fault.
    if (!this.prev.inSession) c = unknown('session open');
    else if (this.gapPending) c = unknown('gap');
    this.gapPending = false;
    const bucket = (this.buckets[idx] ??= emptyBucket());
    bucket.b += c.buy;
    bucket.s += c.sell;
    bucket.u += c.unclassified;
    bucket.m += c.multi;
    this.seen[idx] = true;
    if (c.why === 'gap') this.broken[idx] = true;
    this.stats.buy += c.buy;
    this.stats.sell += c.sell;
    this.stats.unclassified += c.unclassified;
    this.stats.multi += c.multi;
    this.stats.why[c.why] = (this.stats.why[c.why] ?? 0) + c.buy + c.sell + c.unclassified;
    this.prev = { ...snap, dir: c.dir };
    return c;
  }

  /** True if every minute in [from, to) had snapshots and no reconnect gap. */
  covered(from, to) {
    if (from < 0) return false;
    for (let i = from; i < to; i++) if (!this.seen[i] || this.broken[i]) return false;
    return true;
  }

  sum(from, to) {
    const t = { buy: 0, sell: 0, unclassified: 0 };
    for (let i = Math.max(0, from); i < Math.min(SESSION_MINUTES, to); i++) {
      const k = this.buckets[i];
      if (k) {
        t.buy += k.b;
        t.sell += k.s;
        t.unclassified += k.u;
      }
    }
    return { ...t, total: t.buy + t.sell + t.unclassified };
  }

  /** Session CVD (buy - sell) at the end of each minute, null before the first snapshot. */
  cvdCurve() {
    const out = new Array(SESSION_MINUTES).fill(null);
    let cvd = 0;
    let started = false;
    for (let i = 0; i < SESSION_MINUTES; i++) {
      const k = this.buckets[i];
      if (k) cvd += k.b - k.s;
      if (this.seen[i]) started = true;
      if (started && this.seen[i]) out[i] = cvd;
    }
    return out;
  }

  /** For saving to disk: only what is needed to carry on after a restart. */
  toJSON() {
    const buckets = {};
    this.buckets.forEach((k, i) => {
      if (k) buckets[i] = [k.b, k.s, k.u, k.m];
    });
    const flags = (arr) => arr.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    const bookQty = {};
    this.bookQty.forEach((k, i) => {
      if (k?.n) bookQty[i] = [k.buy, k.sell, k.n];
    });
    const depth = {};
    this.depth.forEach((k, i) => {
      if (k) depth[i] = [k.sp, k.sn, k.im, k.imn];
    });
    return { day: this.day, buckets, seen: flags(this.seen), broken: flags(this.broken), stats: this.stats, bookQty, depth };
  }

  /** Restores a saved session. The first snapshot after a restart only re-sets the baseline. */
  static fromJSON(data, cfg = DEFAULT_FLOW_CONFIG) {
    const book = new FlowBook(cfg);
    if (!data || data.day == null) return book;
    book.reset(data.day);
    for (const [i, [b, s, u, m]] of Object.entries(data.buckets ?? {})) book.buckets[Number(i)] = { b, s, u, m };
    for (const [i, [buy, sell, n]] of Object.entries(data.bookQty ?? {})) book.bookQty[Number(i)] = { buy, sell, n };
    for (const [i, [sp, sn, im, imn]] of Object.entries(data.depth ?? {})) book.depth[Number(i)] = { sp, sn, im, imn };
    for (const i of data.seen ?? []) book.seen[i] = true;
    for (const i of data.broken ?? []) book.broken[i] = true;
    book.gapPending = false; // the first snapshot after a restart re-sets the baseline anyway
    book.resumed = true;
    if (data.stats) book.stats = data.stats;
    return book;
  }
}

/**
 * Minutes until a run of `length` fully covered minutes will exist, assuming coverage continues
 * from now. Null before any snapshot has arrived.
 * Without `part` the run must end on a candle boundary (windows of completed candles). With
 * `part` (see windowStats) the windows end at the current moment, so the run only has to reach
 * back `length` minutes from the minute in progress.
 */
export function minutesUntilCovered(book, minuteNow, length, cfg = DEFAULT_FLOW_CONFIG, part = null) {
  if (book.seen.indexOf(true) < 0) return null;
  const rolling = part != null;
  // The clean run starts after the most recent minute that was missed or broken.
  let lastBad = -1;
  for (let i = Math.min(minuteNow, SESSION_MINUTES - (rolling ? 1 : 0)) - (rolling ? 0 : 1); i >= 0; i--) {
    if (!book.seen[i] || book.broken[i]) {
      lastBad = i;
      break;
    }
  }
  if (rolling) return Math.max(0, lastBad + 1 + length - Math.min(minuteNow, SESSION_MINUTES - 1));
  const start = Math.ceil((lastBad + 1) / cfg.candleMinutes) * cfg.candleMinutes;
  return Math.max(0, start + length - minuteNow);
}

/**
 * Buy / sell / unclassified volume over the `length` minutes that end `part` of the way through
 * minute `last`. Volume is stored per minute, so the minute at the old edge counts for the share
 * of it still inside the window (1 - part). `whole` = minute `last` is the one in progress, whose
 * bucket already holds only the elapsed part.
 */
function rollingSum(book, last, length, part, whole) {
  const t = { buy: 0, sell: 0, unclassified: 0 };
  for (let i = Math.max(0, last - length); i <= Math.min(SESSION_MINUTES - 1, last); i++) {
    const k = book.buckets[i];
    if (!k) continue;
    const w = i === last - length ? 1 - part : i === last && !whole ? part : 1;
    t.buy += w * k.b;
    t.sell += w * k.s;
    t.unclassified += w * k.u;
  }
  return { ...t, total: t.buy + t.sell + t.unclassified };
}

/** The minute in progress and how far through it we are, for windows that end at the current moment. */
function rollingClock(minuteNow, part) {
  const m = Math.min(minuteNow, SESSION_MINUTES - 1);
  return { m, part: minuteNow > m ? 1 : Math.min(1, Math.max(0, part)) }; // after the close: the whole last minute
}

const pctOf = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

/** (recent - previous) / previous in percent; null (never NaN or Infinity) when it can't be computed. */
export function changePct(recent, previous) {
  if (recent == null || previous == null || !(previous > 0)) return null;
  return ((recent - previous) / previous) * 100;
}

export function classifyChange(pct, cfg = DEFAULT_FLOW_CONFIG) {
  if (pct == null) return null;
  return pct > cfg.changePct ? 'increasing' : pct < -cfg.changePct ? 'decreasing' : 'flat';
}

export function classifyShare(sellShare, cfg = DEFAULT_FLOW_CONFIG) {
  if (sellShare == null) return null;
  const s = cfg.share;
  if (sellShare > s.strongSell) return 'strong selling dominance';
  if (sellShare >= s.sell) return 'moderate selling dominance';
  if (sellShare > s.buy) return 'balanced';
  if (sellShare >= s.strongBuy) return 'moderate buying dominance';
  return 'strong buying dominance';
}

/**
 * Sell / buy shares over the most recent 15-minute window, and changes against the window before.
 * `minuteNow` is the current session minute index (may be >= SESSION_MINUTES after the close).
 * Without `part`: windows of COMPLETED 5-minute candles, so values step every 5 minutes.
 * With `part` (how far through the current minute we are, 0..1): windows end at the current
 * moment, so values move with every quote.
 */
export function windowStats(book, minuteNow, cfg = DEFAULT_FLOW_CONFIG, part = null) {
  const span = cfg.candleMinutes * cfg.windowCandles;
  let end;
  let recentOk;
  let previousOk;
  let recent;
  let previous;
  if (part == null) {
    end = Math.min(SESSION_MINUTES, Math.floor(Math.max(0, minuteNow) / cfg.candleMinutes) * cfg.candleMinutes);
    recentOk = book.covered(end - span, end);
    previousOk = book.covered(end - 2 * span, end - span);
    recent = recentOk ? book.sum(end - span, end) : null;
    previous = previousOk ? book.sum(end - 2 * span, end - span) : null;
  } else {
    const c = rollingClock(minuteNow, part);
    end = c.m + 1;
    recentOk = minuteNow >= 0 && book.covered(c.m - span, c.m + 1);
    previousOk = minuteNow >= 0 && book.covered(c.m - 2 * span, c.m - span);
    recent = recentOk ? rollingSum(book, c.m, span, c.part, true) : null;
    previous = recentOk && previousOk ? rollingSum(book, c.m - span, span, c.part, false) : null;
  }
  const classified = recent ? recent.buy + recent.sell : 0;
  const sellShare = recent ? pctOf(recent.sell, classified) : null;
  const sellChange = changePct(recent?.sell, previous?.sell);
  const buyChange = changePct(recent?.buy, previous?.buy);
  const need = (windows) => minutesUntilCovered(book, minuteNow, windows * span, cfg, part);
  return {
    windowEnd: end,
    recent,
    previous,
    sellShare,
    buyShare: sellShare == null ? null : 100 - sellShare,
    unclassifiedShare: recent ? pctOf(recent.unclassified, recent.total) : null,
    dominance: classifyShare(sellShare, cfg),
    sellChangePct: sellChange,
    buyChangePct: buyChange,
    totalChangePct: changePct(recent?.total, previous?.total),
    sellChange: classifyChange(sellChange, cfg),
    buyChange: classifyChange(buyChange, cfg),
    minutesUntilShare: recentOk ? 0 : need(1),
    minutesUntilChange: recentOk && previousOk ? 0 : need(2),
  };
}

/** Least-squares slope of ys against 0..n-1. */
function slope(ys) {
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  ys.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  });
  return den ? num / den : 0;
}

/**
 * CVD now, its change over the last window, and its trend over `cvdTrendCandles` points one
 * candle apart. The trend is the fitted slope per candle as a share of the average candle
 * volume, so it means the same thing for a heavily and a lightly traded stock.
 * Without `part` the points are the closes of completed candles; with `part` (see windowStats)
 * the last point is the current moment and the others step back one candle length each.
 */
export function cvdStats(book, minuteNow, cfg = DEFAULT_FLOW_CONFIG, part = null) {
  const curve = book.cvdCurve();
  const lastIdx = curve.findLastIndex((v) => v != null);
  const now = lastIdx < 0 ? null : curve[lastIdx];
  const cm = cfg.candleMinutes;
  const span = cm * cfg.windowCandles;
  const n = cfg.cvdTrendCandles;
  let rate = null;
  let trend = null;
  let slopeShare = null;
  let points = null;
  let volume = 0;
  if (part == null) {
    const end = Math.min(SESSION_MINUTES, Math.floor(Math.max(0, minuteNow) / cm) * cm);
    const at = (minuteEnd) => (minuteEnd >= 1 ? curve[minuteEnd - 1] : null); // CVD at the end of minute (minuteEnd - 1)
    if (at(end) != null && at(end - span) != null && book.covered(end - span, end)) rate = at(end) - at(end - span);
    const start = end - n * cm;
    if (start >= 0 && book.covered(start, end)) {
      points = Array.from({ length: n }, (_, k) => at(start + (k + 1) * cm));
      volume = book.sum(start, end).total / n;
    }
  } else if (minuteNow >= 0 && now != null) {
    const c = rollingClock(minuteNow, part);
    // CVD `back` minutes before the current moment: everything up to that minute, plus the part of it already elapsed then.
    const delta = (i) => (book.buckets[i] ? book.buckets[i].b - book.buckets[i].s : 0);
    const ago = (back) => {
      if (back === 0) return now;
      const i = c.m - back;
      let cvd = 0;
      for (let k = 0; k < i; k++) cvd += delta(k);
      return cvd + c.part * delta(i);
    };
    if (book.covered(c.m - span, c.m + 1)) rate = now - ago(span);
    if (book.covered(c.m - n * cm, c.m + 1)) {
      points = Array.from({ length: n }, (_, k) => ago((n - 1 - k) * cm));
      volume = rollingSum(book, c.m, n * cm, c.part, true).total / n;
    }
  }
  if (points?.every((p) => p != null) && volume > 0) {
    slopeShare = slope(points) / volume;
    trend = slopeShare > cfg.cvdTrendMinSlope ? 'rising' : slopeShare < -cfg.cvdTrendMinSlope ? 'falling' : 'sideways';
  }
  const firstSeen = book.seen.indexOf(true);
  return {
    cvd: now,
    cvdRate: rate,
    cvdTrend: trend,
    cvdSlopeShare: slopeShare,
    minutesUntilTrend: trend ? 0 : minutesUntilCovered(book, minuteNow, n * cm, cfg, part),
    coveredFromMinute: firstSeen < 0 ? null : firstSeen,
    curve,
  };
}

/**
 * Price/CVD divergence on confirmed swings only. `swingLows` / `swingHighs` are the price
 * swings ({ t, price }, oldest first) from 5-minute candles; CVD is read at the end of each
 * swing's candle. Returns 'bullish', 'bearish' or null.
 *   bullish: price made a lower low while CVD made a higher low.
 *   bearish: price made a higher high while CVD made a lower high.
 */
export function divergence(book, swingLows, swingHighs, cfg = DEFAULT_FLOW_CONFIG) {
  const curve = book.cvdCurve();
  const withCvd = (swings) =>
    (swings ?? [])
      .filter((s) => istDay(s.t) === book.day)
      .map((s) => ({ ...s, cvd: curve[Math.min(SESSION_MINUTES - 1, minuteIndex(s.t) + cfg.candleMinutes - 1)] }))
      .filter((s) => s.cvd != null)
      .slice(-2);
  const lows = withCvd(swingLows);
  const highs = withCvd(swingHighs);
  const bullish = lows.length === 2 && lows[1].price < lows[0].price && lows[1].cvd > lows[0].cvd ? lows[1].t : null;
  const bearish = highs.length === 2 && highs[1].price > highs[0].price && highs[1].cvd < highs[0].cvd ? highs[1].t : null;
  if (bullish && bearish) return bullish > bearish ? 'bullish' : 'bearish';
  return bullish ? 'bullish' : bearish ? 'bearish' : null;
}

/**
 * The order-flow measures at the end of every session minute, for the charts: the same windows
 * as the live values (windowStats / cvdStats with the window ending at the minute's end), so a
 * chart point matches what the tile showed at that moment. Null where a window isn't covered.
 * Returns arrays of SESSION_MINUTES values: sellShare, sellChange, buyChange, totalChange (percent),
 * cvdRate (CVD change over the window) and cvdSlope (CVD trend slope as a share of candle volume).
 */
export function flowCurves(book, cfg = DEFAULT_FLOW_CONFIG) {
  const empty = () => new Array(SESSION_MINUTES).fill(null);
  const out = { sellShare: empty(), sellChange: empty(), buyChange: empty(), totalChange: empty(), cvdRate: empty(), cvdSlope: empty() };
  const cm = cfg.candleMinutes;
  const span = cm * cfg.windowCandles;
  const n = cfg.cvdTrendCandles;
  const cum = new Array(SESSION_MINUTES); // CVD at the end of each minute
  let run = 0;
  for (let i = 0; i < SESSION_MINUTES; i++) {
    const k = book.buckets[i];
    if (k) run += k.b - k.s;
    cum[i] = run;
  }
  const lastSeen = book.seen.lastIndexOf(true);
  for (let m = 0; m <= lastSeen; m++) {
    if (!book.seen[m]) continue;
    const w = windowStats(book, m, cfg, 1);
    out.sellShare[m] = w.sellShare;
    out.sellChange[m] = w.sellChangePct;
    out.buyChange[m] = w.buyChangePct;
    out.totalChange[m] = w.totalChangePct;
    if (book.covered(m - span, m + 1)) out.cvdRate[m] = cum[m] - cum[m - span];
    if (book.covered(m - n * cm, m + 1)) {
      const points = Array.from({ length: n }, (_, k) => cum[m - (n - 1 - k) * cm]);
      const volume = rollingSum(book, m, n * cm, 1, true).total / n;
      if (volume > 0) out.cvdSlope[m] = slope(points) / volume;
    }
  }
  return out;
}

/**
 * Order-book measures per session minute, for the charts: the average whole-book buy and sell
 * quantity, the whole-book imbalance, the average spread % and top-5 imbalance, and the ask / bid
 * quantity trend (average of the `minutes` ending at that minute against the `minutes` before,
 * each needing `minSampled` minutes with readings). Null where there were no readings.
 */
export function bookCurves(book, minutes = 15, minSampled = Math.ceil(minutes * 0.8)) {
  const empty = () => new Array(SESSION_MINUTES).fill(null);
  const out = { buyQty: empty(), sellQty: empty(), imbalance: empty(), spreadPct: empty(), imbalance5: empty(), askTrend: empty(), bidTrend: empty() };
  book.bookQty.forEach((k, i) => {
    if (!k?.n) return;
    const buy = k.buy / k.n;
    const sell = k.sell / k.n;
    out.buyQty[i] = buy;
    out.sellQty[i] = sell;
    if (buy + sell > 0) out.imbalance[i] = (buy - sell) / (buy + sell);
  });
  (book.depth ?? []).forEach((k, i) => {
    if (k?.sn) out.spreadPct[i] = k.sp / k.sn;
    if (k?.imn) out.imbalance5[i] = k.im / k.imn;
  });
  const avg = (from, to, side) => {
    let sum = 0;
    let n = 0;
    let sampled = 0;
    for (let i = Math.max(0, from); i <= to; i++) {
      const k = book.bookQty[i];
      if (!k?.n) continue;
      sum += k[side];
      n += k.n;
      sampled++;
    }
    return sampled >= minSampled ? sum / n : null;
  };
  for (let m = 2 * minutes - 1; m < SESSION_MINUTES; m++) {
    if (!book.bookQty[m]?.n) continue;
    out.askTrend[m] = changePct(avg(m - minutes + 1, m, 'sell'), avg(m - 2 * minutes + 1, m - minutes, 'sell'));
    out.bidTrend[m] = changePct(avg(m - minutes + 1, m, 'buy'), avg(m - 2 * minutes + 1, m - minutes, 'buy'));
  }
  return out;
}
