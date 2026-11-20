// HTTP + WebSocket server for the dashboard. Serves the page, a snapshot API, and pushes rows
// to browsers as quotes arrive. Listens on localhost only.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

export function createDashboardServer({ engine, pagePath = 'public/index.html', getStatus = () => ({}) }) {
  const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    if (url.pathname === '/') {
      // Read per request so page edits show up on refresh without restarting the server.
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(readFileSync(pagePath));
    }
    if (url.pathname === '/api/snapshot') return json(res, 200, { status: getStatus(), rows: engine.rows() });
    if (url.pathname === '/api/detail') {
      const d = engine.detail(url.searchParams.get('sym'));
      return d ? json(res, 200, d) : json(res, 404, { error: 'unknown symbol' });
    }
    return json(res, 404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  wss.on('connection', (ws) => send(ws, { type: 'snapshot', status: getStatus(), rows: engine.rows() }));

  return {
    server,
    broadcast(msg) {
      for (const ws of wss.clients) send(ws, msg);
    },
    listen: (port) => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(resolve);
    }),
  };
}
