// Turns Fyers data-socket messages into broker-neutral records. A Kite or Upstox adapter
// would emit the same record shapes, so everything downstream stays broker-agnostic.
//
// Record kinds (short keys keep the files small):
//   q   stock/F&O quote   sym recv exch ltt ltp ltq vol vwap tbq tsq bid ask bq aq o h l pc
//   i   index value       sym recv exch ltp o h l pc
//   d5  5-level depth     sym recv bids asks   (each level [price, qty, orders]; no exchange timestamp)
//   d50 50-level depth    see tbtBook.js
import { toEpochMs } from './time.js';

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const DATA_TYPES = new Set(['sf', 'if', 'dp']);

/**
 * Fyers may send only the fields that changed. Keeping the last full state per symbol and
 * merging each message into it means every record written is a complete snapshot.
 */
export class FyersMessageNormalizer {
  #state = new Map(); // "type|symbol" -> merged fields

  /** Returns a record, or null for control messages (connect/subscribe acks, errors). */
  normalize(msg, recvMs = Date.now()) {
    if (!msg || !DATA_TYPES.has(msg.type) || !msg.symbol) return null;
    const key = `${msg.type}|${msg.symbol}`;
    const merged = { ...this.#state.get(key), ...msg };
    this.#state.set(key, merged);

    if (msg.type === 'sf') return quoteRecord(merged, recvMs);
    if (msg.type === 'if') return indexRecord(merged, recvMs);
    return depthRecord(merged, recvMs);
  }
}

function quoteRecord(m, recv) {
  return {
    k: 'q',
    sym: m.symbol,
    recv,
    exch: toEpochMs(m.exch_feed_time),
    ltt: toEpochMs(m.last_traded_time),
    ltp: num(m.ltp),
    ltq: num(m.last_traded_qty),
    vol: num(m.vol_traded_today),
    vwap: num(m.avg_trade_price),
    tbq: num(m.tot_buy_qty),
    tsq: num(m.tot_sell_qty),
    bid: num(m.bid_price),
    ask: num(m.ask_price),
    bq: num(m.bid_size),
    aq: num(m.ask_size),
    o: num(m.open_price),
    h: num(m.high_price),
    l: num(m.low_price),
    pc: num(m.prev_close_price),
  };
}

function indexRecord(m, recv) {
  return {
    k: 'i',
    sym: m.symbol,
    recv,
    exch: toEpochMs(m.exch_feed_time),
    ltp: num(m.ltp),
    o: num(m.open_price),
    h: num(m.high_price),
    l: num(m.low_price),
    pc: num(m.prev_close_price),
  };
}

function depthSide(m, side) {
  const levels = [];
  for (let i = 1; i <= 5; i++) {
    levels.push([num(m[`${side}_price${i}`]) ?? 0, num(m[`${side}_size${i}`]) ?? 0, num(m[`${side}_order${i}`]) ?? 0]);
  }
  return trimEmptyTail(levels);
}

function depthRecord(m, recv) {
  return { k: 'd5', sym: m.symbol, recv, bids: depthSide(m, 'bid'), asks: depthSide(m, 'ask') };
}

/** Drops trailing levels with no price and no quantity (a thin book), keeping level positions intact. */
export function trimEmptyTail(levels) {
  let end = levels.length;
  while (end > 0 && !levels[end - 1][0] && !levels[end - 1][1]) end--;
  return levels.slice(0, end);
}
