// Reading recorded NDJSON parts back.
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { constants, createGunzip } from 'node:zlib';

/** Sorted part files for one stream on one day; [] if none. */
export function partFiles(root, date, stream) {
  const dir = join(root, date);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(`${stream}-`) && f.endsWith('.ndjson.gz')).sort().map((f) => join(dir, f));
}

/** Most recent recorded day (YYYY-MM-DD folder) under root, or null. */
export function latestDay(root) {
  if (!existsSync(root)) return null;
  return readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().at(-1) ?? null;
}

/** Yields records from one part; a part cut short by a crash is read up to its last flush. */
export async function* readPart(file) {
  // Z_SYNC_FLUSH tolerates a missing gzip trailer instead of throwing.
  const gunzip = createGunzip({ finishFlush: constants.Z_SYNC_FLUSH });
  const lines = createInterface({ input: createReadStream(file).pipe(gunzip), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // a half-written final line in a truncated part
    }
  }
}

/** Last record per symbol for a stream on a day: Map(sym -> record). */
export async function lastBySymbol(root, date, stream) {
  const out = new Map();
  for (const file of partFiles(root, date, stream)) {
    for await (const rec of readPart(file)) if (rec.sym) out.set(rec.sym, rec);
  }
  return out;
}
