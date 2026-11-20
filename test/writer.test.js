import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { constants, gunzipSync } from 'node:zlib';
import { DailyGzipWriter } from '../src/lib/writer.js';

const IST = (iso) => Date.parse(`${iso}+05:30`);
const lines = (file, opts) =>
  gunzipSync(readFileSync(file), opts).toString().trim().split('\n').map((l) => JSON.parse(l));

test('writes gzipped NDJSON and rotates at IST midnight', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rec-'));
  let now = IST('2026-11-18T23:59:58');
  const w = new DailyGzipWriter({ root, stream: 'quotes', now: () => now });
  w.write({ a: 1 });
  now = IST('2026-11-19T00:00:01');
  w.write({ a: 2 });
  w.write({ a: 3 });
  await w.close();

  assert.deepEqual(readdirSync(root).sort(), ['2026-11-18', '2026-11-19']);
  const [day1] = readdirSync(join(root, '2026-11-18'));
  const [day2] = readdirSync(join(root, '2026-11-19'));
  assert.equal(day1, 'quotes-235958.ndjson.gz');
  assert.deepEqual(lines(join(root, '2026-11-18', day1)), [{ a: 1 }]);
  assert.deepEqual(lines(join(root, '2026-11-19', day2)), [{ a: 2 }, { a: 3 }]);
  assert.equal(w.count, 3);
});

test('writes after close are ignored and do not create files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rec-'));
  const w = new DailyGzipWriter({ root, stream: 'events', now: () => IST('2026-11-18T10:00:00') });
  w.write({ a: 1 });
  await w.close();
  w.write({ a: 2 });
  assert.equal(w.count, 1);
  assert.equal(readdirSync(join(root, '2026-11-18')).length, 1);
});

test('a part cut off mid-write is readable up to the last flush', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rec-'));
  const w = new DailyGzipWriter({ root, stream: 'depth5', now: () => IST('2026-11-18T10:00:00') });
  w.write({ a: 1 });
  w.write({ a: 2 });
  w.flush();
  await new Promise((r) => setTimeout(r, 50));
  const file = w.file;
  const flushed = readFileSync(file); // simulate a crash: copy the bytes before close()
  await w.close();
  const crashed = join(root, 'crashed.ndjson.gz');
  writeFileSync(crashed, flushed);
  assert.throws(() => gunzipSync(flushed));
  assert.deepEqual(lines(crashed, { finishFlush: constants.Z_SYNC_FLUSH }), [{ a: 1 }, { a: 2 }]);
});
