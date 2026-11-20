import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FyersMessageNormalizer, trimEmptyTail } from '../src/lib/normalize.js';

test('quote: full message maps to a q record with ms timestamps', () => {
  const n = new FyersMessageNormalizer();
  const rec = n.normalize(
    {
      type: 'sf', symbol: 'NSE:SBIN-EQ', ltp: 812.5, last_traded_qty: 10, vol_traded_today: 123456,
      avg_trade_price: 810.2, tot_buy_qty: 5000, tot_sell_qty: 7000, bid_price: 812.45, ask_price: 812.5,
      bid_size: 40, ask_size: 25, open_price: 805, high_price: 815, low_price: 803, prev_close_price: 806,
      exch_feed_time: 1763440000, last_traded_time: 1763439999,
    },
    1763440000500,
  );
  assert.deepEqual(rec, {
    k: 'q', sym: 'NSE:SBIN-EQ', recv: 1763440000500, exch: 1763440000000, ltt: 1763439999000,
    ltp: 812.5, ltq: 10, vol: 123456, vwap: 810.2, tbq: 5000, tsq: 7000, bid: 812.45, ask: 812.5,
    bq: 40, aq: 25, o: 805, h: 815, l: 803, pc: 806,
  });
});

test('quote: a partial update is merged onto the previous state', () => {
  const n = new FyersMessageNormalizer();
  n.normalize({ type: 'sf', symbol: 'NSE:SBIN-EQ', ltp: 812.5, vol_traded_today: 100, avg_trade_price: 810 });
  const rec = n.normalize({ type: 'sf', symbol: 'NSE:SBIN-EQ', ltp: 813 });
  assert.equal(rec.ltp, 813);
  assert.equal(rec.vol, 100);
  assert.equal(rec.vwap, 810);
});

test('state is kept per symbol and per message type', () => {
  const n = new FyersMessageNormalizer();
  n.normalize({ type: 'sf', symbol: 'NSE:A-EQ', ltp: 1, vol_traded_today: 5 });
  const b = n.normalize({ type: 'sf', symbol: 'NSE:B-EQ', ltp: 2 });
  assert.equal(b.vol, null);
});

test('index message maps to an i record', () => {
  const rec = new FyersMessageNormalizer().normalize(
    { type: 'if', symbol: 'NSE:INDIAVIX-INDEX', ltp: 13.42, prev_close_price: 13.1, exch_feed_time: 1763440000 },
    1,
  );
  assert.deepEqual(rec, {
    k: 'i', sym: 'NSE:INDIAVIX-INDEX', recv: 1, exch: 1763440000000, ltp: 13.42, o: null, h: null, l: null, pc: 13.1,
  });
});

test('depth message maps to d5 with [price, qty, orders] levels and empty tail trimmed', () => {
  const msg = { type: 'dp', symbol: 'NSE:SBIN-EQ' };
  for (let i = 1; i <= 5; i++) {
    msg[`bid_price${i}`] = 606.3 - i * 0.05;
    msg[`bid_size${i}`] = i * 10;
    msg[`bid_order${i}`] = i;
    msg[`ask_price${i}`] = i <= 2 ? 606.3 + i * 0.05 : 0;
    msg[`ask_size${i}`] = i <= 2 ? i * 100 : 0;
    msg[`ask_order${i}`] = i <= 2 ? i : 0;
  }
  const rec = new FyersMessageNormalizer().normalize(msg, 7);
  assert.equal(rec.k, 'd5');
  assert.equal(rec.bids.length, 5);
  assert.deepEqual(rec.bids[0], [606.25, 10, 1]);
  assert.equal(rec.asks.length, 2);
  assert.deepEqual(rec.asks[1], [606.4, 200, 2]);
});

test('control messages and junk return null', () => {
  const n = new FyersMessageNormalizer();
  assert.equal(n.normalize({ type: 'cn', s: 'ok', code: 200, message: 'Authentication done' }), null);
  assert.equal(n.normalize({ type: 'sub', s: 'ok' }), null);
  assert.equal(n.normalize({ s: 'error', code: -300, message: 'Please provide valid token' }), null);
  assert.equal(n.normalize(null), null);
  assert.equal(n.normalize({ type: 'sf' }), null);
});

test('trimEmptyTail keeps interior empty levels', () => {
  assert.deepEqual(trimEmptyTail([[1, 1, 1], [0, 0, 0], [2, 2, 1], [0, 0, 0]]), [[1, 1, 1], [0, 0, 0], [2, 2, 1]]);
  assert.deepEqual(trimEmptyTail([[0, 0, 0]]), []);
});
