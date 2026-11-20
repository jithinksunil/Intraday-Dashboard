import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { SocketMessage } = require('fyers-api-v3/tbtsocket/msg.js');

/** Encodes a TBT packet the way the server would, using the SDK's generated protobuf code. */
export function encodeTbt({ snapshot = false, feeds }) {
  const obj = { type: 'depth', snapshot, feeds: {} };
  for (const f of feeds) {
    const level = (l) => ({
      price: { value: Math.round(l.price * 100) },
      qty: { value: l.qty },
      nord: { value: l.nord },
      ...(l.num != null && { num: { value: l.num } }),
    });
    obj.feeds[f.ticker] = {
      ticker: f.ticker,
      snapshot: f.snapshot ?? snapshot,
      sequenceNo: f.seq,
      feedTime: { value: f.feedTime ?? 1763440000123 },
      sendTime: { value: f.sendTime ?? 1763440000150 },
      depth: {
        ...(f.tbq != null && { tbq: { value: f.tbq } }),
        ...(f.tsq != null && { tsq: { value: f.tsq } }),
        bids: (f.bids ?? []).map(level),
        asks: (f.asks ?? []).map(level),
      },
    };
  }
  return Buffer.from(SocketMessage.encode(SocketMessage.fromObject(obj)).finish());
}
