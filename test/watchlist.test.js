import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWatchlist, validateWatchlist } from '../src/lib/watchlist.js';

test('the shipped watchlist is valid', () => {
  const w = loadWatchlist('config/watchlist.json');
  assert.ok(w.quotes.length > 0);
  assert.equal(w.depth50, 'NSE:RELIANCE-EQ');
  assert.deepEqual(w.warnings, []);
});

test('indices are rejected for depth', () => {
  assert.throws(() => validateWatchlist({ depth5: ['NSE:NIFTY50-INDEX'] }), /no order book/);
  assert.throws(() => validateWatchlist({ depth50: 'NSE:NIFTY50-INDEX' }), /NSE equity or NSE F&O/);
});

test('depth50 must be NSE and a single string', () => {
  assert.throws(() => validateWatchlist({ depth50: 'BSE:SBIN-A' }), /NSE equity or NSE F&O/);
  assert.throws(() => validateWatchlist({ depth50: ['NSE:SBIN-EQ'] }), /one symbol string/);
  assert.equal(validateWatchlist({ quotes: ['NSE:SBIN-EQ'], depth50: null }).depth50, null);
});

test('bad symbols and the free-plan cap are reported', () => {
  assert.throws(() => validateWatchlist({ quotes: ['SBIN'] }), /invalid symbols: SBIN/);
  const many = Array.from({ length: 101 }, (_, i) => `NSE:S${i}-EQ`);
  assert.throws(() => validateWatchlist({ quotes: many }), /free plan allows 100/);
  const sixty = many.slice(0, 60);
  const w = validateWatchlist({ quotes: sixty, depth5: sixty });
  assert.match(w.warnings[0], /counts these separately/);
});

test('duplicates are removed', () => {
  assert.deepEqual(validateWatchlist({ quotes: ['NSE:A-EQ', 'NSE:A-EQ'] }).quotes, ['NSE:A-EQ']);
});
