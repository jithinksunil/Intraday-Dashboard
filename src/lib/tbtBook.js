// Rebuilds 50-level books from the Fyers tick-by-tick (TBT) socket.
//
// The server sends one full snapshot per symbol, then diffs holding only the changed levels.
// Each level carries `num` (its 0-49 position); this applies diffs by `num`. The official Node
// SDK applies them by array position instead, which misplaces levels whenever a diff skips one,
// so this file decodes and merges itself.
import { trimEmptyTail } from './normalize.js';

export const TBT_LEVELS = 50;

/** Protobuf wrapper/Long/plain value -> Number (null if absent). */
export function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    if ('value' in v) return toNum(v.value);
    if (typeof v.toNumber === 'function') return v.toNumber();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const emptySide = () => Array.from({ length: TBT_LEVELS }, () => [0, 0, 0]);
const emptyBook = () => ({ tbq: null, tsq: null, bids: emptySide(), asks: emptySide() });

function applySide(levels, updates) {
  if (!Array.isArray(updates)) return;
  updates.forEach((u, i) => {
    const idx = u.num != null ? toNum(u.num) : i;
    if (idx == null || idx < 0 || idx >= TBT_LEVELS) return;
    const level = levels[idx];
    // Prices arrive in paise, as the SDK also assumes.
    if (u.price != null) level[0] = toNum(u.price) / 100;
    if (u.qty != null) level[1] = toNum(u.qty);
    if (u.nord != null) level[2] = toNum(u.nord);
  });
}

export class TbtBooks {
  #books = new Map();
  #lastSeq = new Map();

  /**
   * Applies one decoded SocketMessage. Returns the d50 records it produced (one per symbol
   * updated). `seqJump` marks a sequence number that is not last+1; whether that means lost
   * data has not been verified against the live feed, so it is recorded, not acted on.
   */
  apply(packet, recvMs = Date.now()) {
    const out = [];
    for (const feed of Object.values(packet?.feeds ?? {})) {
      const sym = feed.ticker;
      if (!sym) continue;
      const snap = Boolean(feed.snapshot || packet.snapshot);
      let book = this.#books.get(sym);
      if (!book || snap) {
        book = emptyBook();
        this.#books.set(sym, book);
      }
      const d = feed.depth;
      if (d) {
        if (d.tbq != null) book.tbq = toNum(d.tbq);
        if (d.tsq != null) book.tsq = toNum(d.tsq);
        applySide(book.bids, d.bids);
        applySide(book.asks, d.asks);
      }

      const seq = toNum(feed.sequenceNo);
      const prev = this.#lastSeq.get(sym);
      const seqJump = !snap && prev != null && seq != null && seq !== prev + 1;
      if (seq != null) this.#lastSeq.set(sym, seq);

      out.push({
        k: 'd50',
        sym,
        recv: recvMs,
        exch: toNum(feed.feedTime),
        sent: toNum(feed.sendTime),
        seq,
        ...(snap && { snap: true }),
        ...(seqJump && { seqJump: true }),
        tbq: book.tbq,
        tsq: book.tsq,
        bids: trimEmptyTail(book.bids).map((l) => [...l]),
        asks: trimEmptyTail(book.asks).map((l) => [...l]),
      });
    }
    return out;
  }
}
