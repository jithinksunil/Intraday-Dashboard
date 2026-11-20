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
    this.stats = { buy: 0, sell: 0, unclassified: 0, multi: 0, why: {} };
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
    return { day: this.day, buckets, seen: flags(this.seen), broken: flags(this.broken), stats: this.stats, bookQty };
  }

  /** Restores a saved session. The first snapshot after a restart only re-sets the baseline. */
  static fromJSON(data, cfg = DEFAULT_FLOW_CONFIG) {
    const book = new FlowBook(cfg);
    if (!data || data.day == null) return book;
    book.reset(data.day);
    for (const [i, [b, s, u, m]] of Object.entries(data.buckets ?? {})) book.buckets[Number(i)] = { b, s, u, m };
    for (const [i, [buy, sell, n]] of Object.entries(data.bookQty ?? {})) book.bookQty[Number(i)] = { buy, sell, n };
    for (const i of data.seen ?? []) book.seen[i] = true;
    for (const i of data.broken ?? []) book.broken[i] = true;
    book.gapPending = false; // the first snapshot after a restart re-sets the baseline anyway
    book.resumed = true;
    if (data.stats) book.stats = data.stats;
    return book;
  }
}

/**
 * Minutes until a run of `length` fully covered minutes, ending on a candle boundary, will exist,
 * assuming coverage continues from now. Null before any snapshot has arrived.
 */
export function minutesUntilCovered(book, minuteNow, length, cfg = DEFAULT_FLOW_CONFIG) {
  if (book.seen.indexOf(true) < 0) return null;
  // The clean run starts after the most recent minute that was missed or broken.
  let lastBad = -1;
  for (let i = Math.min(minuteNow, SESSION_MINUTES) - 1; i >= 0; i--) {
    if (!book.seen[i] || book.broken[i]) {
      lastBad = i;
      break;
    }
  }
  const start = Math.ceil((lastBad + 1) / cfg.candleMinutes) * cfg.candleMinutes;
  return Math.max(0, start + length - minuteNow);
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
 * Shares and changes over the two most recent 15-minute windows of COMPLETED 5-minute candles.
 * `minuteNow` is the current session minute index (may be >= SESSION_MINUTES after the close).
 */
export function windowStats(book, minuteNow, cfg = DEFAULT_FLOW_CONFIG) {
  const span = cfg.candleMinutes * cfg.windowCandles;
  const end = Math.min(SESSION_MINUTES, Math.floor(Math.max(0, minuteNow) / cfg.candleMinutes) * cfg.candleMinutes);
  const recentOk = book.covered(end - span, end);
  const previousOk = book.covered(end - 2 * span, end - span);
  const recent = recentOk ? book.sum(end - span, end) : null;
  const previous = previousOk ? book.sum(end - 2 * span, end - span) : null;
  const classified = recent ? recent.buy + recent.sell : 0;
  const sellShare = recent ? pctOf(recent.sell, classified) : null;
  const sellChange = changePct(recent?.sell, previous?.sell);
  const buyChange = changePct(recent?.buy, previous?.buy);
  const need = (windows) => minutesUntilCovered(book, minuteNow, windows * span, cfg);
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
 * CVD now, its change over the last window, and its trend over the last `cvdTrendCandles`
 * completed candles. The trend is the fitted slope per candle as a share of the average candle
 * volume, so it means the same thing for a heavily and a lightly traded stock.
 */
export function cvdStats(book, minuteNow, cfg = DEFAULT_FLOW_CONFIG) {
  const curve = book.cvdCurve();
  const lastIdx = curve.findLastIndex((v) => v != null);
  const now = lastIdx < 0 ? null : curve[lastIdx];
  const cm = cfg.candleMinutes;
  const end = Math.min(SESSION_MINUTES, Math.floor(Math.max(0, minuteNow) / cm) * cm);
  const span = cm * cfg.windowCandles;
  const at = (minuteEnd) => (minuteEnd >= 1 ? curve[minuteEnd - 1] : null); // CVD at the end of minute (minuteEnd - 1)
  const rate = at(end) != null && at(end - span) != null && book.covered(end - span, end) ? at(end) - at(end - span) : null;

  const n = cfg.cvdTrendCandles;
  let trend = null;
  let slopeShare = null;
  const start = end - n * cm;
  if (start >= 0 && book.covered(start, end)) {
    const points = Array.from({ length: n }, (_, k) => at(start + (k + 1) * cm));
    const volume = book.sum(start, end).total / n;
    if (points.every((p) => p != null) && volume > 0) {
      slopeShare = slope(points) / volume;
      trend = slopeShare > cfg.cvdTrendMinSlope ? 'rising' : slopeShare < -cfg.cvdTrendMinSlope ? 'falling' : 'sideways';
    }
  }
  const firstSeen = book.seen.indexOf(true);
  return {
    cvd: now,
    cvdRate: rate,
    cvdTrend: trend,
    cvdSlopeShare: slopeShare,
    minutesUntilTrend: trend ? 0 : minutesUntilCovered(book, minuteNow, n * cm, cfg),
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
