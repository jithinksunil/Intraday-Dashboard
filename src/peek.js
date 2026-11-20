// Summarises a day's recording and prints the last few records.
// Usage: npm run peek -- <quotes|depth5|depth50|events> [--date YYYY-MM-DD] [--sym NSE:SBIN-EQ] [--n 3]
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { partFiles, readPart } from './lib/records.js';
import { istClock, istDate } from './lib/time.js';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    date: { type: 'string', default: istDate() },
    sym: { type: 'string' },
    n: { type: 'string', default: '3' },
    data: { type: 'string', default: 'data' },
  },
});

const stream = positionals[0];
if (!['quotes', 'depth5', 'depth50', 'events'].includes(stream)) {
  console.error('Usage: npm run peek -- <quotes|depth5|depth50|events> [--date YYYY-MM-DD] [--sym SYMBOL] [--n 3]');
  process.exit(1);
}

const dir = join(args.data, args.date);
const parts = partFiles(args.data, args.date, stream);
if (!parts.length) {
  console.error(`No ${stream} files in ${dir}`);
  process.exit(1);
}

const n = Number(args.n);
const tail = [];
const bySym = new Map();
let total = 0;
for (const part of parts) {
  for await (const rec of readPart(part)) {
    if (args.sym && rec.sym !== args.sym) continue;
    total++;
    const key = rec.sym ?? rec.ev ?? '?';
    const s = bySym.get(key) ?? { count: 0, first: rec.recv, last: rec.recv };
    s.count++;
    s.last = rec.recv;
    bySym.set(key, s);
    tail.push(rec);
    if (tail.length > n) tail.shift();
  }
}

console.log(`${stream} on ${args.date}: ${total} records in ${parts.length} part file(s)\n`);
for (const [key, s] of [...bySym].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${key.padEnd(24)} ${String(s.count).padStart(8)}   ${istClock(s.first)} -> ${istClock(s.last)} IST`);
}
console.log(`\nLast ${tail.length}:`);
for (const rec of tail) console.log(JSON.stringify(rec));
