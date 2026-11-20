import { readFileSync } from 'node:fs';

/** Fyers Standard (free) plan limits, from the API docs' Plans & Limits page. */
export const STANDARD_PLAN = { dataSocketSymbols: 100, tbtSymbols: 1 };

const SYMBOL_RE = /^[A-Z]+:\S+$/;
const isIndex = (s) => s.endsWith('-INDEX');

/** Loads and validates the watchlist. Returns { quotes, depth5, depth50, warnings }. */
export function loadWatchlist(path) {
  return validateWatchlist(JSON.parse(readFileSync(path, 'utf8')));
}

export function validateWatchlist(raw) {
  const errors = [];
  const warnings = [];
  const list = (name) => {
    const v = raw[name] ?? [];
    if (!Array.isArray(v)) {
      errors.push(`"${name}" must be an array of symbols`);
      return [];
    }
    const bad = v.filter((s) => typeof s !== 'string' || !SYMBOL_RE.test(s));
    if (bad.length) errors.push(`"${name}" has invalid symbols: ${bad.join(', ')} (expected e.g. NSE:SBIN-EQ)`);
    return [...new Set(v.filter((s) => typeof s === 'string' && SYMBOL_RE.test(s)))];
  };

  const quotes = list('quotes');
  const depth5 = list('depth5');
  const depth50 = raw.depth50 ?? null;

  const depthIndices = depth5.filter(isIndex);
  if (depthIndices.length) errors.push(`Indices have no order book; remove from "depth5": ${depthIndices.join(', ')}`);

  if (depth50 !== null) {
    if (typeof depth50 !== 'string' || !SYMBOL_RE.test(depth50)) {
      errors.push('"depth50" must be one symbol string, or null to turn it off');
    } else if (!depth50.startsWith('NSE:') || isIndex(depth50)) {
      errors.push(`"depth50" (${depth50}) must be an NSE equity or NSE F&O symbol; 50-level depth is not offered for others`);
    }
  }

  const unique = new Set([...quotes, ...depth5]).size;
  if (unique > STANDARD_PLAN.dataSocketSymbols) {
    errors.push(`${unique} symbols across "quotes" and "depth5"; the free plan allows ${STANDARD_PLAN.dataSocketSymbols}`);
  } else if (quotes.length + depth5.length > STANDARD_PLAN.dataSocketSymbols) {
    warnings.push(
      `${quotes.length} quote + ${depth5.length} depth subscriptions. If Fyers counts these separately ` +
        `this exceeds the free plan's ${STANDARD_PLAN.dataSocketSymbols}; watch the first run for subscribe errors.`,
    );
  }
  if (!quotes.length && !depth5.length && !depth50) errors.push('Watchlist is empty');

  if (errors.length) throw new Error(`Watchlist problems:\n  - ${errors.join('\n  - ')}`);
  return { quotes, depth5, depth50, warnings };
}
