// Candles on disk: data/candles/<resolution>/<symbol>.csv, one file per symbol and resolution.
//
// Plain CSV so pandas, Excel or anything else can read it directly:
//   t,ist,open,high,low,close,volume,oi
// `t` is the candle's start time in epoch seconds (what Fyers returns); `ist` is the same time
// as readable IST text, for eyeballing only. `oi` is empty except for F&O fetched with OI.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HEADER = 't,ist,open,high,low,close,volume,oi';
const IST_OFFSET_S = 5.5 * 3600;

/** NSE:SBIN-EQ -> NSE_SBIN-EQ (safe on every filesystem). */
export const fileSafe = (symbol) => symbol.replace(/[^A-Za-z0-9._-]/g, '_');

export const istText = (t) => new Date((t + IST_OFFSET_S) * 1000).toISOString().slice(0, 16).replace('T', ' ');

export class CandleStore {
  constructor(root = 'data/candles') {
    this.root = root;
  }

  path(symbol, resolution) {
    return join(this.root, resolution, `${fileSafe(symbol)}.csv`);
  }

  /** Candles sorted by time; [] if none stored yet. */
  read(symbol, resolution) {
    const file = this.path(symbol, resolution);
    if (!existsSync(file)) return [];
    const rows = readFileSync(file, 'utf8').trim().split('\n').slice(1);
    return rows.filter(Boolean).map((line) => {
      const [t, , o, h, l, c, v, oi] = line.split(',');
      return { t: Number(t), o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v), oi: oi === '' || oi == null ? null : Number(oi) };
    });
  }

  /** Replaces the file atomically (write to a temp file, then rename), so a crash never leaves half a file. */
  write(symbol, resolution, candles) {
    const file = this.path(symbol, resolution);
    mkdirSync(dirname(file), { recursive: true });
    const body = candles.map((k) => [k.t, istText(k.t), k.o, k.h, k.l, k.c, k.v, k.oi ?? ''].join(','));
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${[HEADER, ...body].join('\n')}\n`);
    renameSync(tmp, file);
  }
}

/** Merges by candle time; incoming candles replace stored ones with the same time. Sorted output. */
export function mergeCandles(existing, incoming) {
  const byTime = new Map(existing.map((k) => [k.t, k]));
  for (const k of incoming) byTime.set(k.t, k);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}
