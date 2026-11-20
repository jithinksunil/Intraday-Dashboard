// Appends records as gzipped NDJSON under data/<IST date>/<stream>-<HHMMSS>.ndjson.gz.
//
// Every process start opens a new part file, so a crash can only truncate the part that was
// open; earlier parts stay intact. The open part is sync-flushed every few seconds, so a
// truncated part is still readable up to the last flush (see peek.js).
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { constants, createGzip } from 'node:zlib';
import { istClock, istDate } from './time.js';

export class DailyGzipWriter {
  constructor({ root = 'data', stream, flushMs = 3000, now = Date.now }) {
    this.root = root;
    this.stream = stream;
    this.now = now;
    this.day = null;
    this.gz = null;
    this.out = null;
    this.count = 0;
    this.file = null;
    this.closed = false;
    this.timer = setInterval(() => this.flush(), flushMs);
    this.timer.unref();
  }

  /** Ignored after close(), so late events during shutdown can't reopen a file. */
  write(record) {
    if (this.closed) return;
    const t = this.now();
    const day = istDate(t);
    if (day !== this.day) this.#rotate(day, t);
    this.gz.write(`${JSON.stringify(record)}\n`);
    this.count++;
  }

  flush() {
    this.gz?.flush(constants.Z_SYNC_FLUSH);
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.#closeCurrent();
  }

  #rotate(day, t) {
    this.#closeCurrent();
    const dir = join(this.root, day);
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${this.stream}-${istClock(t).replaceAll(':', '')}.ndjson.gz`);
    this.out = createWriteStream(this.file, { flags: 'a' });
    this.gz = createGzip();
    this.gz.pipe(this.out);
    this.day = day;
  }

  #closeCurrent() {
    if (!this.gz) return Promise.resolve();
    const { gz, out } = this;
    this.gz = null;
    this.out = null;
    return new Promise((resolve) => {
      out.once('close', resolve);
      gz.end();
    });
  }
}
