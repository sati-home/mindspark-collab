// One HTTP server: the static MindSpark app, /healthz, /api/session, the
// shared-map API (upstream collab-http, unmodified) and WebSocket upgrades
// on the room URLs. Same origin by default, so no CORS unless configured.
import http from 'node:http';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { resolve, join, sep, extname } from 'node:path';
import { handleCollabHttp } from './upstream/collab-http.js';
import { verifyJWT, authorizeRequest } from './upstream/auth-core.js';
import { acceptUpgrade } from './ws.js';
import { createRooms } from './rooms.js';
import { createLimits } from './limits.js';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

// Headers the app's <meta> CSP cannot express (frame-ancestors) or that only a
// server can set. Sent on every response, static or JSON. HSTS belongs on the
// proxy that terminates TLS.
const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
const HTML_HEADERS = { ...SECURITY_HEADERS, 'Content-Security-Policy': "frame-ancestors 'none'" };

const MAX_BODY = 16 * 1024 * 1024;
// Maps are small JSON documents (upstream's own GitHub path caps them at 1 MiB),
// so the collab API gets a much smaller cap than the generic one.
const MAX_COLLAB_BODY = 2 * 1024 * 1024;
const REAP_EVERY_MS = 10_000;

const roomOf = pathname => {
  const rest = pathname.startsWith('/api/collab/') ? pathname.slice('/api/collab/'.length) : null;
  if (rest === null) return null;
  try { return decodeURIComponent(rest.split('/')[0] || ''); } catch { return ''; }
};

export function createApp({ publicDir, storage, session, authSecret, allowedInstances = [], allowedOrigin = '',
  maxBody = MAX_BODY, maxCollabBody = MAX_COLLAB_BODY, limits: limitOpts = {}, requireIdentity = false, trustProxy = false }) {
  const rooms = createRooms(storage);
  const { reapEveryMs = REAP_EVERY_MS, ...limitCfg } = limitOpts;
  const limits = createLimits(limitCfg);
  const reaper = setInterval(limits.reap, reapEveryMs); if (reaper.unref) reaper.unref();
  // The bucket key. Behind a reverse proxy every request arrives from the
  // proxy's address, so TRUST_PROXY switches to the client it forwards for.
  const clientKey = req => {
    if (trustProxy) { const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (xff) return xff; }
    return req.socket.remoteAddress || 'unknown';
  };
  const tooMany = (res) => { res.writeHead(429, { ...SECURITY_HEADERS, ...cors, 'Retry-After': '1', 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"error":"too many requests"}'); };
  const bearer = req => { const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i); return m ? m[1] : ''; };
  const root = resolve(publicDir);
  const env = { AUTH_SECRET: authSecret };
  const cors = allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, PUT, PATCH, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Edit-Token, Authorization' } : {};
  // req is optional: when given, the request's connection is dropped once the
  // response has actually been flushed - never before, or a 413/etc body can
  // race the socket teardown and never reach the client (seen as ECONNRESET).
  const json = (res, status, body, req) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { ...SECURITY_HEADERS, ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    if (req) res.end(payload, () => req.destroy()); else res.end(payload);
  };
  // Unauthenticated bodies must never grow unbounded in memory: past the cap, further
  // chunks are dropped (not buffered) and the promise rejects with a marked error, so
  // callers can answer 413 before any JSON parsing or auth work happens. The caller is
  // responsible for destroying the request once the 413 response has been sent.
  const readBody = (req, cap = maxBody) => new Promise((ok, fail) => {
    const c = []; let total = 0; let tooLarge = false;
    req.on('data', d => {
      if (tooLarge) return;
      total += d.length;
      if (total > cap) {
        tooLarge = true;
        const err = new Error('body too large'); err.code = 'BODY_TOO_LARGE';
        fail(err);
        return;
      }
      c.push(d);
    });
    req.on('end', () => { if (!tooLarge) ok(Buffer.concat(c)); });
    req.on('error', fail);
  });

  // The served index.html gets the allowed forge origins added to connect-src,
  // the same edit upstream documents for self-hosted instances - done here so
  // ALLOWED_INSTANCES is the one place an operator configures them. A function
  // replacer avoids $-substitution on origins that happen to contain '$'.
  const inject = html => allowedInstances.length
    ? html.replace(/connect-src 'self'/, () => "connect-src 'self' " + allowedInstances.join(' ')) : html;

  // Warn once, at startup, if the configured app won't actually get the injection -
  // a silent no-op here would otherwise surface as a mysterious CSP violation later.
  if (allowedInstances.length) {
    const indexPath = join(root, 'index.html');
    try {
      const idxHtml = readFileSync(indexPath, 'utf8');
      if (!/connect-src 'self'/.test(idxHtml)) {
        console.warn(`app: ${indexPath} has no "connect-src 'self'" directive; ALLOWED_INSTANCES will not be injected`);
      }
    } catch { /* index.html missing is fine; serveStatic will 404 on request */ }
  }

  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  function serveStatic(req, res) {
    const bare = status => { res.writeHead(status, SECURITY_HEADERS); res.end(); };
    let pathname; try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return bare(400); }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + sep)) return bare(404);
    // The lexical check above stops `..`; this one stops a symlink under the
    // public dir that points outside it (statSync/readFileSync follow links).
    let real; try { real = realpathSync(file); } catch { return bare(404); }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return bare(404);
    let st; try { st = statSync(real); } catch { return bare(404); }
    if (!st.isFile()) return bare(404);
    const type = TYPES[extname(file)] || 'application/octet-stream';
    let body = readFileSync(real);
    const isHtml = file.endsWith(sep + 'index.html');
    if (isHtml) body = Buffer.from(inject(body.toString('utf8')));
    res.writeHead(200, { ...(isHtml ? HTML_HEADERS : SECURITY_HEADERS), 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    // Node hands the request target through verbatim, and an absolute-form one
    // (RFC 7230 5.3.2, e.g. "GET http://[abc]/ HTTP/1.1") can be unparseable.
    // Parsing outside the try turned that into an unhandled rejection - i.e. a
    // remote kill switch - so the parse gets its own guard and a plain 400.
    let url;
    try { url = new URL(req.url, 'http://x'); }
    catch { return json(res, 400, { error: 'bad request target' }); }
    try {
      if (req.method === 'OPTIONS' && allowedOrigin) { res.writeHead(204, cors); return res.end(); }
      if (url.pathname === '/healthz') return json(res, 200, { mode: 'collab' });
      if (url.pathname === '/api/session') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        if (!limits.allow(clientKey(req))) return tooMany(res);
        let raw; try { raw = await readBody(req); } catch (e) { if (e.code === 'BODY_TOO_LARGE') return json(res, 413, { error: 'body too large' }, req); throw e; }
        let body; try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
        const r = await session(body); return json(res, r.status, r.body);
      }
      const room = roomOf(url.pathname);
      if (room !== null) {
        if (!room) return json(res, 400, { error: 'room required' });
        let body;
        if (req.method === 'GET' || req.method === 'HEAD') body = undefined;
        else {
          if (!limits.allow(clientKey(req))) return tooMany(res);
          // REQUIRE_IDENTITY: no anonymous writes at all - which is what stops
          // anonymous room creation - regardless of what a room's ACL says.
          if (requireIdentity) { const p = await verifyJWT(bearer(req), authSecret); if (!p || p.sub == null) return json(res, 401, { error: 'sign in required' }); }
          try { body = await readBody(req, maxCollabBody); } catch (e) { if (e.code === 'BODY_TOO_LARGE') return json(res, 413, { error: 'body too large' }, req); throw e; }
        }
        const request = new Request('http://collab' + req.url, { method: req.method, headers: req.headers, body });
        const out = await handleCollabHttp(storage.room(room), env, request);
        return json(res, out.status, out.body);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      serveStatic(req, res);
    } catch (e) {
      // Never the URL: room ids in it are capabilities and logs travel.
      const route = url.pathname.startsWith('/api/collab/') ? '/api/collab/<room>' : url.pathname.split('?')[0];
      console.error(req.method, route, e);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  });

  // The WebSocket carries no headers the client can set, so its identity
  // travels as ?token=<jwt> on the upgrade URL - the same JWT /api/session
  // minted. A room that has an access list is then gated exactly like the
  // HTTP API: `read` to join, `write` to store a snapshot or relay an op. A
  // room without one (a live session of an unpublished map) stays open, as
  // upstream's contract has it. An unverifiable token simply means anonymous.
  const refuse = (socket, status, text) => { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  async function wsIdentity(url) {
    const token = url.searchParams.get('token');
    if (!token || !authSecret) return null;
    const p = await verifyJWT(token, authSecret);
    return (p && p.sub != null) ? { sub: String(p.sub), login: p.login || '' } : null;
  }
  // Decide `need` for a room right now (the ACL may change mid-session, e.g. a
  // revoke), so this re-reads storage on every call rather than caching.
  async function wsAllowed(room, identity, need) {
    const store = storage.room(room);
    const acl = await store.get('acl');
    if (!acl) return true;                                                    // no access list: open, per contract
    const editToken = await store.get('editToken');
    return authorizeRequest({ acl, editToken, identity, tokenHeader: '', need, allowClaim: false }).ok;
  }
  server.on('upgrade', (req, socket, head) => {
    // Same unparseable-target hazard as above, and here there is no response
    // object yet: answer by hand on the raw socket and hang up.
    let url;
    try { url = new URL(req.url, 'http://x'); }
    catch { return refuse(socket, 400, 'Bad Request'); }
    const room = roomOf(url.pathname);
    if (!room) return refuse(socket, 404, 'Not Found');
    if (!limits.allow(clientKey(req))) return refuse(socket, 429, 'Too Many Requests');
    (async () => {
      const identity = await wsIdentity(url);
      if (requireIdentity && !identity) return refuse(socket, 401, 'Unauthorized');
      if (!(await wsAllowed(room, identity, 'read'))) return refuse(socket, 403, 'Forbidden');
      if (!limits.acquire(room)) return refuse(socket, 503, 'Service Unavailable');
      const ws = acceptUpgrade(req, socket, head);
      if (!ws) { limits.release(room); return; }
      ws.on('close', () => limits.release(room));
      limits.watch(ws);
      await rooms.join(room, ws, { canWrite: () => wsAllowed(room, identity, 'write') });
    })().catch(() => { try { socket.destroy(); } catch {} });
  });
  server.storage = storage; server.rooms = rooms; server.limits = limits;
  return server;
}
