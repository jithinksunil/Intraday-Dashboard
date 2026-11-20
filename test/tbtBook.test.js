import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TbtBooks, toNum } from '../src/lib/tbtBook.js';
import { encodeTbt, SocketMessage } from './helpers.js';

const decode = (buf) => SocketMessage.decode(buf);
const SYM = 'NSE:RELIANCE-EQ';

const snapshot = () =>
  decode(
    encodeTbt({
      snapshot: true,
      feeds: [{
        ticker: SYM, seq: 100, tbq: 50000, tsq: 64000,
        bids: [0, 1, 2].map((num) => ({ num, price: 1500 - num * 0.1, qty: 100 + num, nord: num + 1 })),
        asks: [0, 1, 2].map((num) => ({ num, price: 1500.1 + num * 0.1, qty: 200 + num, nord: num + 2 })),
      }],
    }),
  );

test('toNum handles wrappers, Long-like objects and plain values', () => {
  assert.equal(toNum({ value: 5 }), 5);
  assert.equal(toNum({ toNumber: () => 9 }), 9);
  assert.equal(toNum({ value: { toNumber: () => 11 } }), 11);
  assert.equal(toNum('3'), 3);
  assert.equal(toNum(null), null);
});

test('snapshot decoded from real protobuf bytes builds the book (paise -> rupees)', () => {
  const books = new TbtBooks();
  const [rec] = books.apply(snapshot(), 42);
  assert.equal(rec.k, 'd50');
  assert.equal(rec.sym, SYM);
  assert.equal(rec.recv, 42);
  assert.equal(rec.seq, 100);
  assert.equal(rec.snap, true);
  assert.equal(rec.exch, 1763440000123);
  assert.equal(rec.tbq, 50000);
  assert.deepEqual(rec.bids, [[1500, 100, 1], [1499.9, 101, 2], [1499.8, 102, 3]]);
  assert.deepEqual(rec.asks[2], [1500.3, 202, 4]);
});

test('a diff that skips levels is applied by num, not by array position', () => {
  const books = new TbtBooks();
  books.apply(snapshot());
  // Only level 2 on the bid side changed; it arrives as the first (and only) array element.
  const [rec] = books.apply(
    decode(encodeTbt({ feeds: [{ ticker: SYM, seq: 101, bids: [{ num: 2, price: 1499.8, qty: 999, nord: 7 }] }] })),
  );
  assert.deepEqual(rec.bids[0], [1500, 100, 1], 'level 0 untouched');
  assert.deepEqual(rec.bids[2], [1499.8, 999, 7], 'level 2 updated');
  assert.equal(rec.snap, undefined);
  assert.equal(rec.seqJump, undefined);
  assert.equal(rec.tbq, 50000, 'totals carried over when absent from the diff');
});

test('sequence jumps are flagged but still applied', () => {
  const books = new TbtBooks();
  books.apply(snapshot());
  const [rec] = books.apply(
    decode(encodeTbt({ feeds: [{ ticker: SYM, seq: 105, asks: [{ num: 0, price: 1500.2, qty: 1, nord: 1 }] }] })),
  );
  assert.equal(rec.seqJump, true);
  assert.deepEqual(rec.asks[0], [1500.2, 1, 1]);
});

test('a new snapshot replaces the book instead of merging into it', () => {
  const books = new TbtBooks();
  books.apply(snapshot());
  const [rec] = books.apply(
    decode(encodeTbt({ snapshot: true, feeds: [{ ticker: SYM, seq: 1, bids: [{ num: 0, price: 1490, qty: 5, nord: 1 }] }] })),
  );
  assert.deepEqual(rec.bids, [[1490, 5, 1]]);
  assert.deepEqual(rec.asks, []);
});

test('levels without num fall back to array position', () => {
  const books = new TbtBooks();
  const [rec] = books.apply(
    decode(encodeTbt({ snapshot: true, feeds: [{ ticker: SYM, seq: 1, bids: [{ price: 10, qty: 1, nord: 1 }, { price: 9, qty: 2, nord: 1 }] }] })),
  );
  assert.deepEqual(rec.bids, [[10, 1, 1], [9, 2, 1]]);
});

test('records are copies, not live references to the book', () => {
  const books = new TbtBooks();
  const [first] = books.apply(snapshot());
  books.apply(decode(encodeTbt({ feeds: [{ ticker: SYM, seq: 101, bids: [{ num: 0, price: 1, qty: 1, nord: 1 }] }] })));
  assert.deepEqual(first.bids[0], [1500, 100, 1]);
});
