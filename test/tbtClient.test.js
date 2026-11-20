// Runs the TBT client against a local WebSocket server that speaks the same protocol.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { TbtClient } from '../src/feeds/tbtClient.js';
import { encodeTbt } from './helpers.js';

const SYM = 'NSE:RELIANCE-EQ';
const packet = (seq, snapshot = false) =>
  encodeTbt({ snapshot, feeds: [{ ticker: SYM, seq, bids: [{ num: 0, price: 100, qty: 1, nord: 1 }] }] });

async function server(opts = {}) {
  const wss = new WebSocketServer({ port: 0, ...opts });
  await once(wss, 'listening');
  return { wss, url: `ws://127.0.0.1:${wss.address().port}` };
}

test('sends auth header, subscribes, resumes the channel, ignores pong, decodes packets', async () => {
  const { wss, url } = await server();
  const client = new TbtClient({ authKey: 'APP-100:tok', symbols: [SYM], url });
  const packets = [];
  client.on('packet', (m) => packets.push(m));

  wss.on('connection', (sock, req) => {
    assert.equal(req.headers.authorization, 'APP-100:tok');
    const got = [];
    sock.on('message', (data) => {
      const text = data.toString();
      if (text === 'ping') return;
      got.push(JSON.parse(text));
      if (got.length === 2) {
        assert.deepEqual(got[0], { type: 1, data: { subs: 1, symbols: [SYM], mode: 'depth', channel: '1' } });
        assert.deepEqual(got[1], { type: 2, data: { resumeChannels: ['1'], pauseChannels: [] } });
        sock.send('pong');
        sock.send(packet(1, true));
        sock.send(packet(2));
      }
    });
  });

  client.start();
  while (packets.length < 2) await once(client, 'packet');
  assert.equal(packets[0].feeds[SYM].ticker, SYM);
  assert.equal(packets[0].snapshot, true);
  client.stop();
  wss.close();
});

test('reconnects after the server drops it and subscribes again', async () => {
  const { wss, url } = await server();
  let connections = 0;
  wss.on('connection', (sock) => {
    connections++;
    sock.on('message', (data) => {
      if (data.toString().includes('resumeChannels')) {
        sock.send(packet(connections, true));
        if (connections === 1) setTimeout(() => sock.terminate(), 20);
      }
    });
  });

  const client = new TbtClient({ authKey: 'a:b', symbols: [SYM], url });
  const delays = [];
  client.on('reconnecting', (d) => delays.push(d));
  client.on('error', () => {});
  client.start();
  await once(client, 'packet');
  await once(client, 'packet'); // second packet only arrives after reconnect + resubscribe
  assert.equal(connections, 2);
  assert.deepEqual(delays, [1000]);
  client.stop();
  wss.close();
});

test('a 401 on connect is fatal and does not retry', async () => {
  const { wss, url } = await server({ verifyClient: (_info, cb) => cb(false, 401) });
  const client = new TbtClient({ authKey: 'a:b', symbols: [SYM], url });
  let reconnects = 0;
  client.on('reconnecting', () => reconnects++);
  // ws emits error and close in the same tick, so listen for both before starting.
  const fatal = once(client, 'fatal');
  const closed = once(client, 'close');
  client.start();
  const [err] = await fatal;
  assert.match(err.message, /401/);
  await closed;
  await new Promise((r) => setTimeout(r, 1200)); // longer than the first backoff
  assert.equal(reconnects, 0);
  wss.close();
});
