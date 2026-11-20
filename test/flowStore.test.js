import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dayText, FlowStore, todayIndex } from '../src/lib/flowStore.js';
import { FlowBook } from '../src/lib/orderFlow.js';

const ist = (s) => Date.parse(`${s}+05:30`);
const q = (time, vol, ltp) => ({ k: 'q', sym: 'X', exch: ist(time), recv: ist(time), ltp, ltq: 1, vol, bid: 99.95, ask: 100.05 });

test('day index <-> date text', () => {
  const day = todayIndex(ist('2026-11-20T10:00:00'));
  assert.equal(dayText(day), '2026-11-20');
  assert.equal(todayIndex(ist('2026-11-20T23:59:00')), day);
  assert.equal(todayIndex(ist('2026-11-21T00:01:00')), day + 1);
});

test('saves one file per stock and day, and loads it back identically', () => {
  const store = new FlowStore(mkdtempSync(join(tmpdir(), 'flow-')));
  const book = new FlowBook();
  book.onQuote(q('2026-11-20T10:00:00', 1000, 100));
  book.onQuote(q('2026-11-20T10:00:01', 1010, 100.05));
  book.onQuote(q('2026-11-20T10:00:02', 1040, 99.95));
  store.save('NSE:SBIN-EQ', book);
  const file = store.path('NSE:SBIN-EQ', book.day);
  assert.ok(file.endsWith(join('2026-11-20', 'NSE_SBIN-EQ.json')));
  assert.equal(existsSync(`${file}.tmp`), false);
  const loaded = store.load('NSE:SBIN-EQ', book.day);
  assert.deepEqual(loaded.toJSON(), book.toJSON());
  assert.deepEqual(loaded.sum(0, 375), { buy: 10, sell: 30, unclassified: 0, total: 40 });
});

test('missing, corrupt or wrong-day files give a fresh book', () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-'));
  const store = new FlowStore(root);
  const day = todayIndex(ist('2026-11-20T10:00:00'));
  assert.equal(store.load('NSE:A-EQ', day).sum(0, 375).total, 0);
  const book = new FlowBook();
  book.onQuote(q('2026-11-20T10:00:00', 1000, 100));
  book.onQuote(q('2026-11-20T10:00:01', 1010, 100.05));
  store.save('NSE:A-EQ', book);
  writeFileSync(store.path('NSE:A-EQ', day), '{ not json');
  assert.equal(store.load('NSE:A-EQ', day).sum(0, 375).total, 0);
  assert.equal(store.load('NSE:A-EQ', day + 1).day, null, 'another day has no file');
  store.save('NSE:B-EQ', new FlowBook()); // nothing recorded yet: nothing written
  assert.deepEqual(readdirSync(join(root, '2026-11-20')), ['NSE_A-EQ.json']);
});
