// Minimal client for the Fyers tick-by-tick (TBT) socket: 50-level depth, NSE equity and F&O.
// Uses the SDK's generated protobuf decoder but handles the connection itself, so it can
// resubscribe after reconnects (the SDK's reconnect path does not) and stop on auth errors.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { SocketMessage } = require('fyers-api-v3/tbtsocket/msg.js');

export const TBT_URL = 'wss://rtsocket-api.fyers.in/versova';
const MAX_BACKOFF_MS = 60_000;

/**
 * Events: open, packet(decodedMessage, recvMs), servererror(msg), error(err),
 *         close(code, reason), reconnecting(delayMs), fatal(err)
 */
export class TbtClient extends EventEmitter {
  constructor({ authKey, symbols, channel = '1', url = TBT_URL }) {
    super();
    this.authKey = authKey;
    this.symbols = symbols;
    this.channel = String(channel);
    this.url = url;
    this.attempt = 0;
    this.stopped = true;
    this.ws = null;
    this.ping = null;
    this.retry = null;
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    this.ws?.close();
  }

  /** Drops the connection so it reconnects and gets a fresh snapshot. */
  kick() {
    this.ws?.terminate();
  }

  #send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  #connect() {
    const ws = new WebSocket(this.url, { headers: { Authorization: this.authKey } });
    this.ws = ws;

    ws.on('open', () => {
      this.attempt = 0;
      this.#send({ type: 1, data: { subs: 1, symbols: this.symbols, mode: 'depth', channel: this.channel } });
      // Subscribing alone does not start the stream; the channel must be resumed.
      this.#send({ type: 2, data: { resumeChannels: [this.channel], pauseChannels: [] } });
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 1000);
      this.emit('open');
    });

    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length <= 8 && buf.toString() === 'pong') return;
      let msg;
      try {
        msg = SocketMessage.decode(buf);
      } catch (err) {
        this.emit('error', new Error(`Could not decode TBT packet (${buf.length} bytes): ${err.message}`));
        return;
      }
      if (msg.error) this.emit('servererror', msg.msg);
      else this.emit('packet', msg, Date.now());
    });

    ws.on('error', (err) => {
      // 401/403 on the upgrade means a bad token or no TBT access on this plan: retrying won't help.
      if (/Unexpected server response: 40[13]/.test(err.message)) {
        this.stopped = true;
        this.emit('fatal', err);
      } else {
        this.emit('error', err);
      }
    });

    ws.on('close', (code, reason) => {
      clearInterval(this.ping);
      this.emit('close', code, reason.toString());
      if (this.stopped) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt++);
      this.emit('reconnecting', delay);
      this.retry = setTimeout(() => this.#connect(), delay);
    });
  }
}
