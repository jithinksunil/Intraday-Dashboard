// Phase 4 (risk) and Phase 7 (performance) maths. Pure functions.
//
// A trade is { side: 'long'|'short', qty, entry, exit, stop, entryT, exitT, costs } with times
// in epoch seconds and costs (brokerage + taxes) in rupees.

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const dir = (t) => (t.side === 'short' ? -1 : 1);

/** Quantity so that hitting the stop loses at most riskPct of capital (and notional stays under maxNotional). */
export function positionSize({ capital, riskPct, entry, stop, lot = 1, slippagePerShare = 0, maxNotional = Infinity }) {
  const perShare = Math.abs(entry - stop) + slippagePerShare;
  if (!(perShare > 0)) return { qty: 0, risk: 0, notional: 0 };
  let qty = Math.floor((capital * riskPct) / 100 / perShare / lot) * lot;
  qty = Math.min(qty, Math.floor(maxNotional / entry / lot) * lot);
  qty = Math.max(qty, 0);
  return { qty, risk: qty * perShare, notional: qty * entry };
}

export const atrStop = ({ side = 'long', entry, atr, mult = 2 }) => (side === 'short' ? entry + mult * atr : entry - mult * atr);
export const riskReward = ({ entry, stop, target }) => Math.abs(target - entry) / Math.abs(entry - stop);

export const grossPnl = (t) => dir(t) * (t.exit - t.entry) * t.qty;
export const netPnl = (t) => grossPnl(t) - (t.costs ?? 0);
/** Net result as a multiple of the amount risked at entry. Null without a stop. */
export const rMultiple = (t) => (t.stop != null && t.stop !== t.entry ? netPnl(t) / (Math.abs(t.entry - t.stop) * t.qty) : null);

/** Largest favourable and adverse move (per share) while the trade was open, from candles. */
export function excursions(t, candles) {
  const bars = candles.filter((k) => k.t >= t.entryT && k.t <= t.exitT);
  if (!bars.length) return { mfe: null, mae: null };
  const hi = Math.max(...bars.map((k) => k.h));
  const lo = Math.min(...bars.map((k) => k.l));
  return t.side === 'short'
    ? { mfe: Math.max(0, t.entry - lo), mae: Math.max(0, hi - t.entry) }
    : { mfe: Math.max(0, hi - t.entry), mae: Math.max(0, t.entry - lo) };
}

function longestRun(flags) {
  let best = 0;
  let run = 0;
  for (const f of flags) {
    run = f ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/**
 * Performance summary of closed trades (in exit order). Sharpe and Sortino here are per-trade
 * (mean net P&L / deviation of net P&L), not annualised.
 */
export function summarize(trades) {
  const pnl = trades.map(netPnl);
  const wins = pnl.filter((p) => p > 0);
  const losses = pnl.filter((p) => p < 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const p of pnl) {
    equity += p;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const m = mean(pnl);
  const sd = Math.sqrt(mean(pnl.map((p) => (p - m) ** 2)));
  const downside = Math.sqrt(mean(pnl.map((p) => Math.min(p, 0) ** 2)));
  const rs = trades.map(rMultiple).filter((r) => r != null);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  return {
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    avgWin: wins.length ? mean(wins) : null,
    avgLoss: losses.length ? mean(losses) : null,
    expectancy: trades.length ? m : null,
    profitFactor: grossLoss ? wins.reduce((a, b) => a + b, 0) / grossLoss : null,
    netPnl: equity,
    costs: trades.reduce((s, t) => s + (t.costs ?? 0), 0),
    maxDrawdown,
    sharpePerTrade: sd ? m / sd : null,
    sortinoPerTrade: downside ? m / downside : null,
    avgR: rs.length ? mean(rs) : null,
    avgHoldMin: trades.length ? mean(trades.map((t) => (t.exitT - t.entryT) / 60)) : null,
    maxConsecutiveWins: longestRun(pnl.map((p) => p > 0)),
    maxConsecutiveLosses: longestRun(pnl.map((p) => p < 0)),
  };
}
