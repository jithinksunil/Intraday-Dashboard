// Holds the live state behind the dashboard: latest quote per symbol, the RVOL baseline, and
// today's per-minute curves (cumulative volume, price, VWAP). Fed with normalized quote records; no I/O of its own.
import { atr, ema, istDay, last, pctChange, pivots, relativeAtrByTime, resample, roc, rsi, swings, toDaily, trueRanges } from './indicators.js';
import { changePct, cvdStats, DEFAULT_FLOW_CONFIG, divergence, FlowBook, windowStats } from './orderFlow.js';
import { buildBaseline, minuteIndex, rvolAt, SESSION_MINUTES, todayCurve, windowRvol } from './rvol.js';
import { inMarketHours } from './time.js';
import { sessionPriceCurves, vwapDeviationPct } from './vwapCurve.js';

const ROC_BARS = 10;
const RSI_BARS = 14;
const SWING_WING = 2; // a swing is the extreme of 5 candles: itself and 2 on each side
const EMA_BARS = 20;
const SLOPE_BARS = 5; // EMA slope % = change in the EMA over this many candles
const RECENT_MINUTES = 15; // recent RVOL and the order-book quantity trend use 15-minute windows
const VOLUME_TREND_PCT = 20; // recent RVOL up or down by more than this = rising / falling
const BOOK_TREND_PCT = 10; // average book quantity up or down by more than this = increasing / reducing

export class RvolEngine {
  /**
   * @param symbols      symbols to track
   * @param loadCandles  (symbol) => stored 1-minute candles
   * @param onNewDay     optional (symbol, day) => void, called when a quote arrives for a
   *                     session the baseline wasn't built for (so history can be refreshed)
   * @param flowStore    optional { load(symbol, day, cfg), save(symbol, book) }: keeps the
   *                     session's order-flow buckets across restarts
   * @param flowConfig   order-flow window lengths and thresholds
   */
  constructor({ symbols, loadCandles, lookback = 20, onNewDay = () => {}, flowStore = null, flowConfig = DEFAULT_FLOW_CONFIG }) {
    this.loadCandles = loadCandles;
    this.lookback = lookback;
    this.onNewDay = onNewDay;
    this.flowStore = flowStore;
    this.flowConfig = flowConfig;
    this.state = new Map(symbols.map((sym) => [sym, { sym, day: null, baseline: null, today: null, price: null, vwapCurve: null }]));
  }

  /** Rebuilds a symbol's baseline and today-curve from stored candles (after a history refresh). */
  reload(sym) {
    const s = this.state.get(sym);
    if (!s || s.day == null) return;
    const m1 = this.loadCandles(sym);
    s.baseline = buildBaseline(m1, s.day, this.lookback);
    const stored = todayCurve(m1, s.day);
    // Keep live points that are newer than what is stored.
    s.today = stored.map((v, i) => v ?? s.today?.[i] ?? null);
    // Recent RVOL: the last 15 minutes of completed candles against the usual volume of those
    // same minutes, and the same 15 minutes earlier. Windows end on a 5-minute candle boundary.
    const lastStored = stored.findLastIndex((v) => v != null);
    const end = Math.floor((lastStored + 1) / 5) * 5;
    s.recentRvol = windowRvol(stored, s.baseline, end, RECENT_MINUTES);
    s.priorRvol = windowRvol(stored, s.baseline, end - RECENT_MINUTES, RECENT_MINUTES);
    s.recentRvolCurve = new Array(SESSION_MINUTES).fill(null);
    for (let e = RECENT_MINUTES; e <= end; e += 5) s.recentRvolCurve[e - 1] = windowRvol(stored, s.baseline, e, RECENT_MINUTES)?.rvol ?? null;
    // Previous session's high, low and close, for pivot points.
    s.prevDay = toDaily(m1.slice(-3000)).filter((k) => istDay(k.t) < s.day).at(-1) ?? null;
    // Volatility on completed 5-minute candles: true range, ATR(14), and ATR relative to the
    // average ATR at the same time of day over the previous 20 sessions. A still-forming last
    // candle is left out. 9,000 one-minute candles cover those 20 sessions with room to spare.
    const c5 = resample(m1.slice(-9000), 5);
    if (c5.length && m1[m1.length - 1].t < c5[c5.length - 1].t + 240) c5.pop();
    const tr = trueRanges(c5);
    const a = atr(c5, 14);
    s.tr5 = last(tr);
    s.atr5 = last(a);
    const rel = relativeAtrByTime(c5, a, 20);
    s.relAtr = rel?.ratio ?? null;
    s.atrUsual = rel?.usual ?? null;
    s.relAtrSessions = rel?.sessions ?? 0;
    s.atrUsualCurve = new Array(SESSION_MINUTES).fill(null);
    for (const [sod, v] of rel?.usualCurve ?? []) {
      const i = Math.floor((sod - 33300) / 60); // 33300 s = 09:15
      if (i >= 0 && i < SESSION_MINUTES) s.atrUsualCurve[i] = v;
    }
    // Swing highs and lows on the same candles (most recent last). A swing needs 2 completed
    // candles after it, so the newest one is always at least 10 minutes old.
    const sw = swings(c5.slice(-300), SWING_WING);
    s.swingHighs = sw.highs.slice(-5);
    s.swingLows = sw.lows.slice(-5);
    // Momentum on the same candles: ROC(10) and RSI(14) of the closes.
    s.closes5 = c5.map((k) => k.c);
    s.lastCandleT = c5.length ? c5[c5.length - 1].t : null;
    const rocSeries = roc(s.closes5, ROC_BARS);
    const rsiSeries = rsi(s.closes5, RSI_BARS);
    // Trend on the same candles: EMA(20) of the closes and its slope in percent.
    const emaSeries = ema(s.closes5, EMA_BARS);
    const slopeSeries = pctChange(emaSeries, SLOPE_BARS);
    s.emaCurve = new Array(SESSION_MINUTES).fill(null);
    s.slopeCurve = new Array(SESSION_MINUTES).fill(null);
    s.rocCurve = new Array(SESSION_MINUTES).fill(null);
    s.rsiCurve = new Array(SESSION_MINUTES).fill(null);
    s.trCurve = new Array(SESSION_MINUTES).fill(null);
    s.atrCurve = new Array(SESSION_MINUTES).fill(null);
    c5.forEach((k, n) => {
      const i = minuteIndex(k.t);
      if (istDay(k.t) !== s.day || i < 0 || i >= SESSION_MINUTES) return;
      s.emaCurve[i] = emaSeries[n];
      s.slopeCurve[i] = slopeSeries[n];
      s.rocCurve[i] = rocSeries[n];
      s.rsiCurve[i] = rsiSeries[n];
      s.trCurve[i] = tr[n];
      s.atrCurve[i] = a[n];
    });
    const pc = sessionPriceCurves(m1, s.day);
    s.price = pc.price.map((v, i) => v ?? s.price?.[i] ?? null);
    s.vwapCurve = pc.vwap.map((v, i) => v ?? s.vwapCurve?.[i] ?? null);
  }

  /** Applies a quote record; returns the row to show, or null if the symbol isn't tracked. */
  onQuote(q) {
    const s = this.state.get(q.sym);
    if (!s || q.k !== 'q') return null;
    const tMs = q.exch ?? q.recv;
    const tSec = Math.floor(tMs / 1000);
    const day = istDay(tSec);
    if (day !== s.day) {
      const first = s.day == null;
      s.day = day;
      s.today = null;
      s.price = null;
      s.vwapCurve = null;
      // Order flow for this session: carried over from disk after a restart, otherwise new.
      s.flow = this.flowStore?.load(q.sym, day, this.flowConfig) ?? new FlowBook(this.flowConfig);
      this.reload(q.sym);
      if (!first) this.onNewDay(q.sym, day);
    }
    Object.assign(s, { ltp: q.ltp, prevClose: q.pc, volume: q.vol, vwap: q.vwap, asOf: tMs, recv: q.recv, totalBuyQty: q.tbq, totalSellQty: q.tsq });
    const idx = minuteIndex(tSec);
    s.flow.onQuote(q);
    if (q.tbq != null && q.tsq != null) s.flow.addBookQty(idx, q.tbq, q.tsq); // saved with the flow book
    if (idx >= 0) {
      const i = Math.min(idx, SESSION_MINUTES - 1);
      if (q.vol != null) s.today[i] = q.vol;
      if (q.ltp != null) s.price[i] = q.ltp;
      // The feed's VWAP is the exchange's own session VWAP, so it replaces the candle estimate.
      if (q.vwap) s.vwapCurve[i] = q.vwap;
    }
    // Momentum includes the candle now forming, with the last price standing in for its close.
    // Outside the session, or before the next candle has started, only completed candles count.
    const forming = idx >= 0 && idx < SESSION_MINUTES && s.lastCandleT != null && tSec >= s.lastCandleT + 300 && q.ltp != null;
    const closes = forming ? [...s.closes5, q.ltp] : (s.closes5 ?? []);
    s.roc = last(roc(closes, ROC_BARS));
    s.rsi = last(rsi(closes, RSI_BARS));
    const emaLive = ema(closes, EMA_BARS);
    s.ema = last(emaLive);
    s.emaSlopePct = last(pctChange(emaLive, SLOPE_BARS));
    const r = rvolAt(s.baseline, q.vol, tSec);
    s.rvol = r?.rvol ?? null;
    s.expected = r?.expected ?? null;
    return this.row(q.sym);
  }

  /** Applies a 5-level depth record; returns the row to show, or null if the symbol isn't tracked. */
  onDepth(d) {
    const s = this.state.get(d.sym);
    if (!s || d.k !== 'd5') return null;
    s.book = { bids: d.bids, asks: d.asks, recv: d.recv };
    return this.row(d.sym);
  }

  /** Spread and imbalance from the latest book. Null fields when the book is missing or one-sided. */
  bookMetrics(s) {
    const b = s.book;
    const out = { book: b ?? null, bookLive: false, spread: null, spreadPct: null, bidQty5: null, askQty5: null, imbalance5: null, imbalanceBook: null };
    if (s.totalBuyQty != null && s.totalSellQty != null && s.totalBuyQty + s.totalSellQty > 0) {
      out.imbalanceBook = (s.totalBuyQty - s.totalSellQty) / (s.totalBuyQty + s.totalSellQty);
    }
    if (!b) return out;
    // Outside 09:15-15:30 the book is left over from the close or the pre-open auction.
    out.bookLive = inMarketHours(b.recv);
    const sum = (levels) => levels.reduce((n, l) => n + l[1], 0);
    out.bidQty5 = sum(b.bids);
    out.askQty5 = sum(b.asks);
    if (out.bidQty5 + out.askQty5 > 0) out.imbalance5 = (out.bidQty5 - out.askQty5) / (out.bidQty5 + out.askQty5);
    const bid = b.bids[0]?.[0];
    const ask = b.asks[0]?.[0];
    if (bid > 0 && ask > bid) {
      out.spread = ask - bid;
      out.spreadPct = (out.spread / ((ask + bid) / 2)) * 100;
    } else if (bid > 0 && ask === bid) {
      out.spread = 0;
      out.spreadPct = 0;
    }
    return out;
  }

  /**
   * Classic floor pivots from the previous session, and the levels on either side of the price.
   * The close is the exchange's official previous close from the feed when available (the
   * candle close is the last trade at 15:29, which can differ from the official close).
   */
  pivotMetrics(s) {
    const out = { pivots: null, prevDay: null, support: null, resistance: null };
    if (!s.prevDay) return out;
    const prev = { h: s.prevDay.h, l: s.prevDay.l, c: s.prevClose || s.prevDay.c };
    const p = pivots(prev);
    out.prevDay = prev;
    out.pivots = p;
    if (s.ltp == null) return out;
    const levels = [['S3', p.s3], ['S2', p.s2], ['S1', p.s1], ['Pivot', p.p], ['R1', p.r1], ['R2', p.r2], ['R3', p.r3]];
    const below = levels.filter(([, v]) => v <= s.ltp).at(-1);
    const above = levels.find(([, v]) => v > s.ltp);
    const pack = (lv) => (lv ? { name: lv[0], price: lv[1], distancePct: ((lv[1] - s.ltp) / s.ltp) * 100 } : null);
    out.support = pack(below);
    out.resistance = pack(above);
    return out;
  }

  /** The most recent swing high (resistance) and swing low (support), and whether price has broken them. */
  swingMetrics(s) {
    const pack = (sw, broken) => (sw ? {
      price: sw.price,
      t: sw.t,
      distancePct: s.ltp != null ? ((sw.price - s.ltp) / s.ltp) * 100 : null,
      broken: s.ltp != null ? broken(sw.price) : null,
    } : null);
    return {
      swingHigh: pack(s.swingHighs?.at(-1), (p) => s.ltp > p),
      swingLow: pack(s.swingLows?.at(-1), (p) => s.ltp < p),
      swingHighs: s.swingHighs ?? [],
      swingLows: s.swingLows ?? [],
    };
  }

  /** Call when the feed reconnects, so volume traded during the outage is not guessed at. */
  markFeedGap() {
    for (const s of this.state.values()) s.flow?.markGap();
  }

  /** Writes every stock's order-flow buckets to the store. */
  saveFlow() {
    if (!this.flowStore) return;
    for (const [sym, s] of this.state) if (s.flow?.day != null) this.flowStore.save(sym, s.flow);
  }

  /**
   * Estimated order flow (buy / sell volume shares and changes, CVD), plus two exact measures:
   * recent RVOL from completed candles and the trend in whole-book quantity.
   */
  flowMetrics(s) {
    const out = { flow: null, recentRvol: s.recentRvol?.rvol ?? null, priorRvol: s.priorRvol?.rvol ?? null, volumeTrendPct: null, volumeTrend: null, askQtyTrend: null, bidQtyTrend: null };
    out.volumeTrendPct = changePct(s.recentRvol?.rvol, s.priorRvol?.rvol);
    if (out.volumeTrendPct != null) out.volumeTrend = out.volumeTrendPct > VOLUME_TREND_PCT ? 'rising' : out.volumeTrendPct < -VOLUME_TREND_PCT ? 'falling' : 'steady';
    if (!s.flow || s.asOf == null) return out;
    const minuteNow = minuteIndex(Math.floor(s.asOf / 1000));

    // Whole-book quantity: average over the last 15 completed minutes against the 15 before.
    const end = Math.min(SESSION_MINUTES, Math.floor(Math.max(0, minuteNow) / 5) * 5);
    const avg = (from, to, side) => {
      let sum = 0;
      let n = 0;
      for (let i = Math.max(0, from); i < to; i++) {
        const k = s.flow.bookQty[i];
        if (k?.n) {
          sum += k[side] / k.n;
          n++;
        }
      }
      return from >= 0 && n >= (to - from) * 0.8 ? sum / n : null; // needs most of the window sampled
    };
    const trend = (side) => {
      const pct = changePct(avg(end - RECENT_MINUTES, end, side), avg(end - 2 * RECENT_MINUTES, end - RECENT_MINUTES, side));
      return { pct, label: pct == null ? null : pct > BOOK_TREND_PCT ? 'increasing' : pct < -BOOK_TREND_PCT ? 'reducing' : 'flat' };
    };
    // Minutes until both windows are sampled well enough, assuming samples keep arriving from now.
    const sampledBy = (from, to) => {
      let n = 0;
      for (let i = Math.max(0, from); i < to; i++) if (s.flow.bookQty[i]?.n || i >= minuteNow) n++;
      return from >= 0 && n >= (to - from) * 0.8;
    };
    let bookWait = null;
    if (minuteNow >= 0) {
      for (let e = end; e <= SESSION_MINUTES; e += 5) {
        if (sampledBy(e - RECENT_MINUTES, e) && sampledBy(e - 2 * RECENT_MINUTES, e - RECENT_MINUTES)) {
          bookWait = Math.max(0, e - minuteNow);
          break;
        }
      }
    }
    out.askQtyTrend = { ...trend('sell'), minutesUntil: bookWait };
    out.bidQtyTrend = { ...trend('buy'), minutesUntil: bookWait };

    const w = windowStats(s.flow, minuteNow, this.flowConfig);
    const c = cvdStats(s.flow, minuteNow, this.flowConfig);
    const st = s.flow.stats;
    const all = st.buy + st.sell + st.unclassified;
    out.flow = {
      estimated: true, // classified from once-a-second snapshots, not from individual trades
      sellShare: w.sellShare,
      buyShare: w.buyShare,
      dominance: w.dominance,
      unclassifiedShare: w.unclassifiedShare,
      sellVolume: w.recent?.sell ?? null,
      buyVolume: w.recent?.buy ?? null,
      sellChangePct: w.sellChangePct,
      buyChangePct: w.buyChangePct,
      totalChangePct: w.totalChangePct,
      sellChange: w.sellChange,
      buyChange: w.buyChange,
      minutesUntilShare: w.minutesUntilShare,
      minutesUntilChange: w.minutesUntilChange,
      cvd: c.cvd,
      cvdRate: c.cvdRate,
      cvdTrend: c.cvdTrend,
      cvdSlopeShare: c.cvdSlopeShare,
      minutesUntilTrend: c.minutesUntilTrend,
      coveredFromMinute: c.coveredFromMinute,
      divergence: divergence(s.flow, s.swingLows, s.swingHighs, this.flowConfig),
      sessionUnclassifiedShare: all ? (st.unclassified / all) * 100 : null,
      sessionMultiTradeShare: all ? (st.multi / all) * 100 : null,
    };
    return out;
  }

  row(sym) {
    const s = this.state.get(sym);
    return {
      sym,
      ltp: s.ltp ?? null,
      changePct: s.ltp != null && s.prevClose ? ((s.ltp - s.prevClose) / s.prevClose) * 100 : null,
      volume: s.volume ?? null,
      expected: s.expected ?? null,
      rvol: s.rvol ?? null,
      vwap: s.vwap || null,
      vwapDevPct: vwapDeviationPct(s.ltp, s.vwap),
      ema: s.ema ?? null,
      emaSlopePct: s.emaSlopePct ?? null,
      priceVsEmaPct: s.ema && s.ltp != null ? ((s.ltp - s.ema) / s.ema) * 100 : null,
      roc: s.roc ?? null,
      rsi: s.rsi ?? null,
      tr5: s.tr5 ?? null,
      atr5: s.atr5 ?? null,
      atrPct: s.atr5 && s.ltp ? (s.atr5 / s.ltp) * 100 : null,
      relAtr: s.relAtr ?? null,
      atrUsual: s.atrUsual ?? null,
      relAtrSessions: s.relAtrSessions ?? 0,
      vwapDevAtr: s.ltp != null && s.vwap && s.atr5 ? (s.ltp - s.vwap) / s.atr5 : null,
      asOf: s.asOf ?? null,
      recv: s.recv ?? null,
      baselineSessions: s.baseline?.sessions ?? 0,
      ...this.bookMetrics(s),
      ...this.pivotMetrics(s),
      ...this.swingMetrics(s),
      ...this.flowMetrics(s),
    };
  }

  rows() {
    return [...this.state.keys()].map((sym) => this.row(sym));
  }

  /** Curves for the charts, one point per session minute: volume (average vs today), price and VWAP. */
  detail(sym) {
    const s = this.state.get(sym);
    if (!s) return null;
    return { ...this.row(sym), average: s.baseline?.curve ?? null, today: s.today ?? null, price: s.price ?? null, vwapCurve: s.vwapCurve ?? null, trCurve: s.trCurve ?? null, atrCurve: s.atrCurve ?? null, atrUsualCurve: s.atrUsualCurve ?? null, rocCurve: s.rocCurve ?? null, rsiCurve: s.rsiCurve ?? null, emaCurve: s.emaCurve ?? null, slopeCurve: s.slopeCurve ?? null, cvdCurve: s.flow?.cvdCurve() ?? null, recentRvolCurve: s.recentRvolCurve ?? null };
  }
}
