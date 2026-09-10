// One HTTP server: the static MindSpark app, /healthz, /api/session, the
// shared-map API (upstream collab-http, unmodified) and WebSocket upgrades
// on the room URLs. Same origin by default, so no CORS unless configured.
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { handleCollabHttp } from './upstream/collab-http.js';
import { acceptUpgrade } from './ws.js';
import { createRooms } from './rooms.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

const roomOf = pathname => {
  const rest = pathname.startsWith('/api/collab/') ? pathname.slice('/api/collab/'.length) : null;
  if (rest === null) return null;
  try { return decodeURIComponent(rest.split('/')[0] || ''); } catch { return ''; }
};

export function createApp({ publicDir, storage, session, authSecret, allowedInstances = [], allowedOrigin = '' }) {
  const rooms = createRooms(storage);
  const root = resolve(publicDir);
  const env = { AUTH_SECRET: authSecret };
  const cors = allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, PUT, PATCH, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token, Authorization' } : {};
  const json = (res, status, body) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  const readBody = req => new Promise((ok, fail) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', fail); });

  // The served index.html gets the allowed forge origins added to connect-src,
  // the same edit upstream documents for self-hosted instances - done here so
  // ALLOWED_INSTANCES is the one place an operator configures them.
  const inject = html => allowedInstances.length
    ? html.replace(/connect-src 'self'/, "connect-src 'self' " + allowedInstances.join(' ')) : html;

  function serveStatic(req, res) {
    let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(404); return res.end(); }
    let st; try { st = statSync(file); } catch { res.writeHead(404); return res.end(); }
    if (!st.isFile()) { res.writeHead(404); return res.end(); }
    const type = TYPES[extname(file)] || 'application/octet-stream';
    let body = readFileSync(file);
    if (file.endsWith(sep + 'index.html')) body = Buffer.from(inject(body.toString('utf8')));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'OPTIONS' && allowedOrigin) { res.writeHead(204, cors); return res.end(); }
      if (url.pathname === '/healthz') return json(res, 200, { mode: 'collab' });
      if (url.pathname === '/api/session') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        let body; try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
        const r = await session(body); return json(res, r.status, r.body);
      }
      const room = roomOf(url.pathname);
      if (room !== null) {
        if (!room) return json(res, 400, { error: 'room required' });
        const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await readBody(req);
        const request = new Request('http://collab' + req.url, { method: req.method, headers: req.headers, body });
        const out = await handleCollabHttp(storage.room(room), env, request);
        return json(res, out.status, out.body);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      serveStatic(req, res);
    } catch (e) {
      console.error(req.method, req.url, e);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const room = roomOf(new URL(req.url, 'http://x').pathname);
    if (!room) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
    const ws = acceptUpgrade(req, socket, head);
    if (ws) rooms.join(room, ws).catch(() => ws.close(1011));
  });
  server.storage = storage; server.rooms = rooms;
  return server;
}
