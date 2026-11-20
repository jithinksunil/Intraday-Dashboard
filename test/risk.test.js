import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as risk from '../src/lib/risk.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('position size from risk per trade, lot size, slippage buffer and notional cap', () => {
  // 1% of 5,00,000 = 5,000 risk; 10 per share -> 500 shares
  assert.deepEqual(risk.positionSize({ capital: 500000, riskPct: 1, entry: 1000, stop: 990 }), { qty: 500, risk: 5000, notional: 500000 });
  assert.equal(risk.positionSize({ capital: 500000, riskPct: 1, entry: 1000, stop: 990, slippagePerShare: 2.5 }).qty, 400);
  assert.equal(risk.positionSize({ capital: 500000, riskPct: 1, entry: 1000, stop: 990, lot: 75 }).qty, 450);
  assert.equal(risk.positionSize({ capital: 500000, riskPct: 1, entry: 1000, stop: 990, maxNotional: 200000 }).qty, 200);
  assert.equal(risk.positionSize({ capital: 500000, riskPct: 1, entry: 1000, stop: 1000 }).qty, 0);
  assert.equal(risk.positionSize({ capital: 500000, riskPct: 1, entry: 1000, stop: 1010 }).qty, 500, 'short: stop above entry');
});

test('stops, reward:risk, P&L and R-multiple for longs and shorts', () => {
  assert.equal(risk.atrStop({ entry: 100, atr: 2, mult: 2 }), 96);
  assert.equal(risk.atrStop({ side: 'short', entry: 100, atr: 2, mult: 2 }), 104);
  assert.equal(risk.riskReward({ entry: 100, stop: 98, target: 106 }), 3);
  const long = { side: 'long', qty: 10, entry: 100, exit: 106, stop: 98, costs: 5 };
  assert.equal(risk.netPnl(long), 55);
  near(risk.rMultiple(long), 55 / 20);
  const short = { side: 'short', qty: 10, entry: 100, exit: 103, stop: 102, costs: 0 };
  assert.equal(risk.netPnl(short), -30);
  assert.equal(risk.rMultiple(short), -1.5);
  assert.equal(risk.rMultiple({ ...long, stop: undefined }), null);
});

test('MFE and MAE from candles during the trade', () => {
  const candles = [{ t: 0, h: 200, l: 1 }, { t: 60, h: 104, l: 99 }, { t: 120, h: 107, l: 101 }, { t: 180, h: 300, l: 0 }];
  assert.deepEqual(risk.excursions({ side: 'long', entry: 100, entryT: 60, exitT: 120 }, candles), { mfe: 7, mae: 1 });
  assert.deepEqual(risk.excursions({ side: 'short', entry: 100, entryT: 60, exitT: 120 }, candles), { mfe: 1, mae: 7 });
  assert.deepEqual(risk.excursions({ side: 'long', entry: 100, entryT: 999, exitT: 1000 }, candles), { mfe: null, mae: null });
});

test('performance summary', () => {
  const t = (pnl, i) => ({ side: 'long', qty: 1, entry: 100, exit: 100 + pnl, stop: 90, costs: 0, entryT: i * 600, exitT: i * 600 + 300 });
  const s = risk.summarize([100, -50, -50, 200, 100].map(t));
  assert.equal(s.trades, 5);
  assert.equal(s.winRate, 0.6);
  near(s.avgWin, 400 / 3);
  assert.equal(s.avgLoss, -50);
  assert.equal(s.expectancy, 60);
  assert.equal(s.profitFactor, 4);
  assert.equal(s.netPnl, 300);
  assert.equal(s.maxDrawdown, 100); // 100 -> 0 after two losses
  assert.equal(s.maxConsecutiveWins, 2);
  assert.equal(s.maxConsecutiveLosses, 2);
  assert.equal(s.avgHoldMin, 5);
  near(s.avgR, 6);
  assert.ok(s.sharpePerTrade > 0 && s.sortinoPerTrade > s.sharpePerTrade);
  const empty = risk.summarize([]);
  assert.equal(empty.winRate, null);
  assert.equal(empty.netPnl, 0);
});
