// Saves each stock's order-flow buckets and whole-book quantity samples for the session, so a
// restart keeps the day's CVD and the ask / bid quantity trend.
// One small JSON file per stock: data/flow/<IST date>/<symbol>.json
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileSafe } from './candleStore.js';
import { FlowBook } from './orderFlow.js';

const IST_OFFSET_S = 19_800;
/** IST day index (as used by FlowBook.day) -> "YYYY-MM-DD". */
export const dayText = (day) => new Date(day * 86_400_000).toISOString().slice(0, 10);
export const todayIndex = (nowMs = Date.now()) => Math.floor((nowMs / 1000 + IST_OFFSET_S) / 86_400);

export class FlowStore {
  constructor(root = 'data/flow') {
    this.root = root;
  }

  path(symbol, day) {
    return join(this.root, dayText(day), `${fileSafe(symbol)}.json`);
  }

  /** Written to a temp file and renamed, so a crash never leaves half a file. */
  save(symbol, book) {
    if (book.day == null) return;
    const file = this.path(symbol, book.day);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(book.toJSON()));
    renameSync(`${file}.tmp`, file);
  }

  /** The saved book for that day, or a fresh one if there is none or the file is unreadable. */
  load(symbol, day, cfg) {
    const file = this.path(symbol, day);
    if (!existsSync(file)) return new FlowBook(cfg);
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return data.day === day ? FlowBook.fromJSON(data, cfg) : new FlowBook(cfg);
    } catch {
      return new FlowBook(cfg);
    }
  }
}
