import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createApp } from '../app.js';
import { openStorage } from '../storage.js';
import { createSession } from '../session.js';
import { signJWT } from '../upstream/auth-core.js';

const SECRET = 'test-secret';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'msc-app-'));
  const pub = join(dir, 'public'); mkdirSync(pub);
  writeFileSync(join(pub, 'index.html'), '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'self\' https://api.github.com; img-src \'self\'"><p>app</p>');
  writeFileSync(join(pub, 'app.js'), 'console.log(1)');
  writeFileSync(join(dir, 'secret.txt'), 'nope');
  return { dir, pub };
}
async function start(over = {}) {
  const { dir, pub } = fixture();
  const storage = openStorage(join(dir, 'collab.db'));
  const fetchImpl = async (url, o) => (o.headers.Authorization === 'Bearer good')
    ? { ok: true, status: 200, json: async () => ({ id: 5, username: 'ada' }) } : { ok: false, status: 401, json: async () => ({}) };
  const session = createSession({ secret: SECRET, allowedInstances: ['https://gitlab.example'], fetchImpl });
  const srv = createApp({ publicDir: pub, storage, session, authSecret: SECRET, allowedInstances: ['https://gitlab.example'], ...over });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { srv, base, storage, dir };
}
const j = async r => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers });
// Speak HTTP by hand: fetch() will not send an absolute-form request target,
// and that is exactly the shape Node hands straight to the handler.
const raw = (base, text) => new Promise((ok, fail) => {
  const { port, hostname } = new URL(base);
  const sock = net.connect(Number(port), hostname, () => sock.write(text));
  let out = '';
  sock.setTimeout(4000, () => { sock.destroy(); ok(out); });
  sock.on('data', d => { out += d; if (out.includes('\r\n\r\n')) { sock.destroy(); ok(out); } });
  sock.on('end', () => ok(out));
  sock.on('close', () => ok(out));
  sock.on('error', e => (out ? ok(out) : fail(e)));
});

describe('app', () => {
  const started = [];
  after(() => started.forEach(s => { s.srv.close(); s.storage.close(); rmSync(s.dir, { recursive: true, force: true }); }));

  test('health says collab; static app is served with the allowed instances injected into connect-src', async () => {
    const s = await start(); started.push(s);
    const health = await j(await fetch(s.base + '/healthz'));
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { mode: 'collab' });
    const html = await (await fetch(s.base + '/')).text();
    assert.match(html, /connect-src 'self' https:\/\/gitlab\.example https:\/\/api\.github\.com/);
    assert.match(html, /<p>app<\/p>/);
    const js = await fetch(s.base + '/app.js');
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(s.base + '/../secret.txt')).status, 404, 'no traversal');
    assert.equal((await fetch(s.base + '/%2e%2e/secret.txt')).status, 404, 'no encoded traversal');
    assert.equal((await fetch(s.base + '/nope.js')).status, 404);
  });

  test('POST /api/session mints an identity; GET is 405', async () => {
    const s = await start(); started.push(s);
    const r = await j(await fetch(s.base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forge: 'gitlab', instance: 'https://gitlab.example', token: 'good' }) }));
    assert.equal(r.status, 200); assert.equal(r.body.id, 'gitlab:gitlab.example:5');
    assert.equal((await fetch(s.base + '/api/session')).status, 405);
  });

  test('the collab API runs upstream collab-http against SQLite: PUT claims, GET reads, ACL is owner-only', async () => {
    const s = await start(); started.push(s);
    const owner = await signJWT({ sub: 'gitlab:gitlab.example:5', login: 'ada' }, SECRET, 3600);
    const other = await signJWT({ sub: 'gitlab:gitlab.example:6', login: 'bob' }, SECRET, 3600);
    const put = await j(await fetch(s.base + '/api/collab/room1', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + owner }, body: JSON.stringify({ title: 'M', nodes: {} }) }));
    assert.equal(put.status, 200);
    const acl = await j(await fetch(s.base + '/api/collab/room1/acl', { headers: { Authorization: 'Bearer ' + owner } }));
    assert.equal(acl.status, 200); assert.equal(acl.body.ownerId, 'gitlab:gitlab.example:5');
    assert.equal((await fetch(s.base + '/api/collab/room1/acl', { headers: { Authorization: 'Bearer ' + other } })).status, 403);
    const get = await j(await fetch(s.base + '/api/collab/room1', { headers: { Authorization: 'Bearer ' + owner } }));
    assert.deepEqual(get.body, { title: 'M', nodes: {} });
    assert.equal((await fetch(s.base + '/api/collab/room1', { headers: { Authorization: 'Bearer ' + other } })).status, 403, 'linkAccess none');
    assert.equal((await fetch(s.base + '/api/collab/')).status, 400, 'room required');
  });

  test('HTTP PATCH {ops} merges into the stored snapshot', async () => {
    const s = await start(); started.push(s);
    const owner = await signJWT({ sub: 'gitlab:gitlab.example:5', login: 'ada' }, SECRET, 3600);
    const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + owner };
    const put = await j(await fetch(s.base + '/api/collab/patchroom', { method: 'PUT', headers: auth, body: JSON.stringify({ title: 'M', nodes: {} }) }));
    assert.equal(put.status, 200);
    const patch = await j(await fetch(s.base + '/api/collab/patchroom', { method: 'PATCH', headers: auth,
      body: JSON.stringify({ ops: [{ t: 'node', id: 'n1', n: { text: 'x' } }] }) }));
    assert.equal(patch.status, 200);
    const get = await j(await fetch(s.base + '/api/collab/patchroom', { headers: auth }));
    assert.deepEqual(get.body.nodes, { n1: { text: 'x' } });
    assert.equal(get.body.title, 'M', 'a node op leaves the rest of the snapshot alone');
  });

  test('WebSocket on the room URL joins the relay and sees the stored snapshot', async () => {
    const s = await start(); started.push(s);
    await s.storage.room('room2').put('snapshot', { title: 'live' });
    const c = new WebSocket(s.base.replace('http', 'ws') + '/api/collab/room2');
    const welcome = await new Promise(r => { c.onmessage = e => r(JSON.parse(e.data)); });
    assert.equal(welcome.t, 'welcome'); assert.deepEqual(welcome.snapshot, { title: 'live' });
    c.close();
    // A refused upgrade surfaces as `error` and, depending on the Node version,
    // may or may not be followed by `close` (22 stops at error, 26 closes too) -
    // so settle on whichever comes first and assert the socket never opened.
    const bad = new WebSocket(s.base.replace('http', 'ws') + '/other');
    const outcome = await new Promise(r => { bad.onopen = () => r('open'); bad.onerror = () => r('error'); bad.onclose = e => r('close:' + e.code); });
    assert.notEqual(outcome, 'open', 'upgrade outside the room path is refused');
    assert.notEqual(outcome, 'close:1000', 'a refusal is not a clean close');
  });

  test('CORS headers only when an allowed origin is configured', async () => {
    const a = await start(); started.push(a);
    assert.equal((await fetch(a.base + '/healthz')).headers.get('access-control-allow-origin'), null);
    const b = await start({ allowedOrigin: 'https://app.example' }); started.push(b);
    const pre = await fetch(b.base + '/api/collab/r', { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://app.example');
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  });

  test('a request body over the cap is rejected with 413; just under the cap still works', async () => {
    const s = await start({ maxBody: 1000, maxCollabBody: 1000 }); started.push(s);
    const over = 'x'.repeat(1001);
    const overSession = await j(await fetch(s.base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: over }));
    assert.equal(overSession.status, 413);
    assert.equal(overSession.body.error, 'body too large');

    const owner = await signJWT({ sub: 'gitlab:gitlab.example:5', login: 'ada' }, SECRET, 3600);
    const overPut = await fetch(s.base + '/api/collab/roombig', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + owner }, body: JSON.stringify({ title: 'x'.repeat(1001) }) });
    assert.equal(overPut.status, 413);

    const underPut = await j(await fetch(s.base + '/api/collab/roomsmall', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + owner }, body: JSON.stringify({ title: 'ok', nodes: {} }) }));
    assert.equal(underPut.status, 200);
  });

  test('a malformed absolute-form request target is answered 400, not a crash', async () => {
    const s = await start(); started.push(s);
    const res = await raw(s.base, 'GET http://[abc]/ HTTP/1.1\r\nHost: x\r\n\r\n');
    assert.match(res, /^HTTP\/1\.1 400/, 'bad request target must be a 400');
    const health = await j(await fetch(s.base + '/healthz'));
    assert.equal(health.status, 200, 'the server survives the malformed target');
  });

  test('a malformed absolute-form target on an upgrade is answered 400, not a crash', async () => {
    const s = await start(); started.push(s);
    const res = await raw(s.base, 'GET http://[abc]/ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    assert.match(res, /^HTTP\/1\.1 400/, 'bad upgrade target must be a 400');
    const health = await j(await fetch(s.base + '/healthz'));
    assert.equal(health.status, 200, 'the server survives the malformed upgrade target');
  });

  test('CSP directive missing from index.html is left unchanged and warned once at createApp time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'msc-app-nocsp-'));
    const pub = join(dir, 'public'); mkdirSync(pub);
    writeFileSync(join(pub, 'index.html'), '<p>no csp here</p>');
    const storage = openStorage(join(dir, 'collab.db'));
    const session = createSession({ secret: SECRET, allowedInstances: ['https://gitlab.example'] });
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    let srv;
    try {
      srv = createApp({ publicDir: pub, storage, session, authSecret: SECRET, allowedInstances: ['https://gitlab.example'] });
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /index\.html/);
    assert.match(warnings[0], /connect-src/);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const html = await (await fetch(base + '/')).text();
    assert.equal(html, '<p>no csp here</p>');
    srv.close(); storage.close(); rmSync(dir, { recursive: true, force: true });
  });
});

import { configFromEnv } from '../server.js';
describe('config', () => {
  test('no AUTH_SECRET is fatal; ALLOWED_INSTANCES must be bare origins', () => {
    assert.throws(() => configFromEnv({}), /AUTH_SECRET is required/);
    assert.throws(() => configFromEnv({ AUTH_SECRET: 's', ALLOWED_INSTANCES: 'https://gitlab.example/foo' }), /bare origins/);
    const c = configFromEnv({ AUTH_SECRET: 's', ALLOWED_INSTANCES: ' https://gitlab.example , https://codeberg.org', PORT: '8080' });
    assert.deepEqual(c.allowedInstances, ['https://gitlab.example', 'https://codeberg.org']); assert.equal(c.port, 8080);
    assert.throws(() => configFromEnv({ AUTH_SECRET: 's', PORT: 'abc' }), /PORT must be an integer between 1 and 65535/);
    assert.throws(() => configFromEnv({ AUTH_SECRET: 's', PORT: '0' }), /PORT must be an integer between 1 and 65535/);
    assert.throws(() => configFromEnv({ AUTH_SECRET: 's', PORT: '70000' }), /PORT must be an integer between 1 and 65535/);
  });
});

// A room that has an access list is gated on the WebSocket too: the client
// passes its identity as ?token=<jwt> on the upgrade, joins need `read`, and
// snapshot/op frames need `write` - the same decisions the HTTP API makes.
// Rooms without an ACL (live sessions of unpublished maps) stay open.
describe('WebSocket identity gate', () => {
  const started = [], socks = [];
  after(() => { socks.forEach(c => { try { c.close(); } catch {} }); started.forEach(s => { s.srv.closeAllConnections?.(); s.srv.close(); s.storage.close(); }); });
  const OWNER = 'gitlab:gitlab.example:5', VIEWER = 'gitlab:gitlab.example:6';
  const ws = (s, room, jwt) => { const c = new WebSocket(s.base.replace('http', 'ws') + '/api/collab/' + room + (jwt ? '?token=' + encodeURIComponent(jwt) : '')); socks.push(c); return c; };
  const open = c => new Promise((ok, no) => { const q = []; c.onmessage = e => q.push(JSON.parse(e.data)); c.onopen = () => ok({ c, q }); c.onerror = () => no(new Error('refused')); c.onclose = e => no(new Error('closed ' + e.code)); });
  const until = async (q, pred) => { for (let i = 0; i < 100; i++) { const m = q.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 10)); } return null; };
  async function gated(linkAccess = 'none') {
    const s = await start(); started.push(s);
    await s.storage.room('g').put('acl', { ownerId: OWNER, ownerLogin: 'ada', members: { [VIEWER]: { role: 'viewer', login: 'bob' } }, linkAccess });
    await s.storage.room('g').put('snapshot', { title: 'secret' });
    return s;
  }

  test('anonymous upgrade to a room with linkAccess none is refused; the owner joins', async () => {
    const s = await gated('none');
    await assert.rejects(open(ws(s, 'g')), /refused|closed/, 'no identity, no link access');
    const owner = await signJWT({ sub: OWNER, login: 'ada' }, SECRET, 600);
    const a = await open(ws(s, 'g', owner));
    const w = await until(a.q, m => m.t === 'welcome');
    assert.deepEqual(w.snapshot, { title: 'secret' });
    a.c.close();
  });

  test('a viewer joins but cannot store snapshots or relay ops; cursors still relay', async () => {
    const s = await gated('none');
    const owner = await signJWT({ sub: OWNER, login: 'ada' }, SECRET, 600);
    const viewer = await signJWT({ sub: VIEWER, login: 'bob' }, SECRET, 600);
    const a = await open(ws(s, 'g', owner)); await until(a.q, m => m.t === 'welcome');
    const b = await open(ws(s, 'g', viewer)); await until(b.q, m => m.t === 'welcome');
    b.c.send(JSON.stringify({ t: 'snapshot', map: { title: 'overwritten' } }));
    b.c.send(JSON.stringify({ t: 'op', ops: [{ t: 'node', id: 'n1', n: {} }] }));
    b.c.send(JSON.stringify({ t: 'cur', x: 1, y: 2 }));
    const cur = await until(a.q, m => m.t === 'cur');
    assert.ok(cur, 'a viewer may still show a cursor');
    assert.equal(a.q.find(m => m.t === 'op'), undefined, 'a viewer\'s op must not reach the others');
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(await s.storage.room('g').get('snapshot'), { title: 'secret' }, 'a viewer must not overwrite the snapshot');
    a.c.send(JSON.stringify({ t: 'snapshot', map: { title: 'by owner' } }));
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(await s.storage.room('g').get('snapshot'), { title: 'by owner' });
    a.c.close(); b.c.close();
  });

  test('an anonymous link with edit access still works, and a bad token counts as anonymous', async () => {
    const s = await gated('edit');
    const a = await open(ws(s, 'g', 'not-a-jwt')); await until(a.q, m => m.t === 'welcome');
    a.c.send(JSON.stringify({ t: 'snapshot', map: { title: 'anon edit' } }));
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(await s.storage.room('g').get('snapshot'), { title: 'anon edit' });
    a.c.close();
  });

  test('a room without an access list stays open to anonymous sockets', async () => {
    const s = await start(); started.push(s);
    const a = await open(ws(s, 'free')); await until(a.q, m => m.t === 'welcome');
    a.c.send(JSON.stringify({ t: 'snapshot', map: { title: 'live' } }));
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(await s.storage.room('free').get('snapshot'), { title: 'live' });
    a.c.close();
  });
});

// Limits wired into the server: a per-IP bucket on the costly routes, socket
// caps, the idle reaper, a smaller body cap for the collab API, and the
// optional REQUIRE_IDENTITY mode for deployments that never want anonymous
// room creation.
describe('limits and identity mode', () => {
  const started = [], socks = [];
  after(() => { socks.forEach(c => { try { c.close(); } catch {} }); started.forEach(s => { s.srv.closeAllConnections?.(); s.srv.close(); s.storage.close(); }); });
  const ws = (s, room, jwt) => { const c = new WebSocket(s.base.replace('http', 'ws') + '/api/collab/' + room + (jwt ? '?token=' + encodeURIComponent(jwt) : '')); socks.push(c); return c; };
  const open = c => new Promise((ok, no) => { c.onopen = () => ok(c); c.onerror = () => no(new Error('refused')); c.onclose = e => no(new Error('closed ' + e.code)); });

  test('the session and collab-write routes are rate limited per client; reads and static files are not', async () => {
    const s = await start({ limits: { ratePerMin: 60, burst: 2 } }); started.push(s);
    const post = () => fetch(s.base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.notEqual((await post()).status, 429); assert.notEqual((await post()).status, 429);
    const third = await post();
    assert.equal(third.status, 429);
    assert.equal(third.headers.get('retry-after'), '1');
    assert.equal((await fetch(s.base + '/healthz')).status, 200, 'reads stay open');
    assert.equal((await fetch(s.base + '/api/collab/r1')).status, 404, 'GET on a room is not metered');
  });

  test('a collab body over its own smaller cap is 413 while the session cap stays as configured', async () => {
    const s = await start({ maxCollabBody: 500, maxBody: 5000 }); started.push(s);
    const big = JSON.stringify({ title: 'x'.repeat(600) });
    const r = await fetch(s.base + '/api/collab/r2', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: big });
    assert.equal(r.status, 413);
    const r2 = await fetch(s.base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(600) }) });
    assert.notEqual(r2.status, 413);
  });

  test('socket caps: the third socket in a room is refused; total cap too', async () => {
    const s = await start({ limits: { maxSockets: 3, maxSocketsPerRoom: 2 } }); started.push(s);
    await open(ws(s, 'cap')); await open(ws(s, 'cap'));
    await assert.rejects(open(ws(s, 'cap')), /refused|closed/, 'per-room cap');
    await open(ws(s, 'other'));
    await assert.rejects(open(ws(s, 'third')), /refused|closed/, 'total cap');
  });

  test('a silent socket is closed 1001 after idleMs', async () => {
    const s = await start({ limits: { idleMs: 150, reapEveryMs: 50 } }); started.push(s);
    const c = await open(ws(s, 'idle'));
    const code = await new Promise(r => { c.onclose = e => r(e.code); });
    assert.equal(code, 1001);
  });

  test('REQUIRE_IDENTITY: anonymous room writes and upgrades are refused, identified ones work', async () => {
    const s = await start({ requireIdentity: true }); started.push(s);
    const anon = await fetch(s.base + '/api/collab/req', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"title":"m"}' });
    assert.equal(anon.status, 401);
    await assert.rejects(open(ws(s, 'req')), /refused|closed/);
    const jwt = await signJWT({ sub: 'gitlab:gitlab.example:5', login: 'ada' }, SECRET, 600);
    const ok = await fetch(s.base + '/api/collab/req', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt }, body: '{"title":"m"}' });
    assert.equal(ok.status, 200);
    await open(ws(s, 'req', jwt));
    assert.equal((await fetch(s.base + '/api/collab/req', { headers: { Authorization: 'Bearer ' + jwt } })).status, 200);
  });

  test('behind a trusted proxy the bucket key is the forwarded client address', async () => {
    const s = await start({ limits: { ratePerMin: 60, burst: 1 }, trustProxy: true }); started.push(s);
    const post = ip => fetch(s.base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: '{}' });
    assert.notEqual((await post('10.0.0.1')).status, 429);
    assert.equal((await post('10.0.0.1')).status, 429);
    assert.notEqual((await post('10.0.0.2')).status, 429, 'a different client has its own bucket');
  });
});

// Hardening from the review: response headers the meta-CSP cannot carry,
// symlinks that would escape PUBLIC_DIR, and error logs without room ids.
describe('hardening', () => {
  const started = [];
  after(() => started.forEach(s => { s.srv.closeAllConnections?.(); s.srv.close(); s.storage.close(); }));

  test('every response carries clickjacking, sniffing and referrer protection', async () => {
    const s = await start(); started.push(s);
    for (const path of ['/', '/app.js', '/healthz', '/api/collab/']) {
      const h = (await fetch(s.base + path)).headers;
      assert.equal(h.get('x-frame-options'), 'DENY', path);
      assert.equal(h.get('x-content-type-options'), 'nosniff', path);
      assert.equal(h.get('referrer-policy'), 'no-referrer', path);
      assert.equal(h.get('cross-origin-opener-policy'), 'same-origin-allow-popups', path + ' (a strict same-origin COOP breaks the OAuth popup)');
    }
    const html = await fetch(s.base + '/');
    assert.match(html.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, 'the header CSP carries what the meta tag cannot');
  });

  test('a symlink under PUBLIC_DIR pointing outside is not served', async () => {
    const s = await start(); started.push(s);
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(s.dir, 'secret.txt'), join(s.dir, 'public', 'leak.txt'));
    assert.equal((await fetch(s.base + '/leak.txt')).status, 404);
    assert.equal((await fetch(s.base + '/app.js')).status, 200, 'regular files still served');
  });

  test('a handler failure is logged without the request URL (room ids are capabilities)', async () => {
    const s = await start(); started.push(s);
    const lines = []; const orig = console.error; console.error = (...a) => lines.push(a.map(String).join(' '));
    try {
      s.srv.rooms.join = () => { throw new Error('boom'); };   // not reachable via HTTP; use the collab route with a poisoned storage instead
      s.storage.room = () => ({ get: async () => { throw new Error('boom'); }, put: async () => {} });
      assert.equal((await fetch(s.base + '/api/collab/secret-room-id-42')).status, 500);
    } finally { console.error = orig; }
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /secret-room-id-42/);
    assert.match(lines[0], /collab/);
  });
});
