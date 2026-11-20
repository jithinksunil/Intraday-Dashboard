import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CandleStore, fileSafe, istText, mergeCandles } from '../src/lib/candleStore.js';

const k = (t, c = 100, oi = null) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 10, oi });
const T0 = Date.parse('2026-11-18T09:15:00+05:30') / 1000;

test('round-trips candles through CSV, including empty OI', () => {
  const store = new CandleStore(mkdtempSync(join(tmpdir(), 'candles-')));
  const candles = [k(T0), k(T0 + 60, 101.5, 2500)];
  store.write('NSE:SBIN-EQ', '1m', candles);
  assert.deepEqual(store.read('NSE:SBIN-EQ', '1m'), candles);
  const file = store.path('NSE:SBIN-EQ', '1m');
  assert.ok(file.endsWith(join('1m', 'NSE_SBIN-EQ.csv')));
  assert.equal(existsSync(`${file}.tmp`), false, 'temp file renamed away');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines[0], 't,ist,open,high,low,close,volume,oi');
  assert.equal(lines[1], `${T0},2026-11-18 09:15,100,101,99,100,10,`);
  assert.equal(lines[2], `${T0 + 60},2026-11-18 09:16,101.5,102.5,100.5,101.5,10,2500`);
});

test('reading a symbol with no file returns []', () => {
  assert.deepEqual(new CandleStore(mkdtempSync(join(tmpdir(), 'candles-'))).read('NSE:X-EQ', 'D'), []);
});

test('merge replaces same-time candles with the newer copy and sorts', () => {
  const merged = mergeCandles([k(3), k(1)], [k(2), k(3, 999)]);
  assert.deepEqual(merged.map((c) => c.t), [1, 2, 3]);
  assert.equal(merged[2].c, 999);
});

test('fileSafe and istText', () => {
  assert.equal(fileSafe('NSE:NIFTY100 EQL WGT-INDEX'), 'NSE_NIFTY100_EQL_WGT-INDEX');
  assert.equal(istText(1690934400), '2023-08-02 05:30');
});
