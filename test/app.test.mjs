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
    const bad = new WebSocket(s.base.replace('http', 'ws') + '/other');
    const code = await new Promise(r => { bad.onclose = e => r(e.code); bad.onerror = () => {}; });
    assert.notEqual(code, 1000, 'upgrade outside the room path is refused');
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
    const s = await start({ maxBody: 1000 }); started.push(s);
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
