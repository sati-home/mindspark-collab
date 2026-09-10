// Start the real server on a free port, join two live clients, relay one op,
// store a snapshot over HTTP and see it in the next welcome. Exits non-zero on
// any mismatch. Run: npm run e2e
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { openStorage } from '../storage.js';
import { createSession } from '../session.js';
import { signJWT } from '../upstream/auth-core.js';

const dir = mkdtempSync(join(tmpdir(), 'msc-e2e-'));
const storage = openStorage(join(dir, 'collab.db'));
const SECRET = 'e2e';
const srv = createApp({ publicDir: join(dir), storage, session: createSession({ secret: SECRET }), authSecret: SECRET });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`, ws = base.replace('http', 'ws');
const open = url => new Promise((ok, no) => { const c = new WebSocket(url); const q = []; c.onmessage = e => q.push(JSON.parse(e.data)); c.onopen = () => ok({ c, q }); c.onerror = no; });
const until = async (q, pred) => { for (let i = 0; i < 100; i++) { const m = q.find(pred); if (m) return m; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout'); };

const a = await open(ws + '/api/collab/e2e'), b = await open(ws + '/api/collab/e2e');
const wa = await until(a.q, m => m.t === 'welcome'), wb = await until(b.q, m => m.t === 'welcome');
assert.equal(wb.peers.length, 1);
a.c.send(JSON.stringify({ t: 'op', ops: [{ t: 'node', id: 'n1', n: { text: 'hi' } }] }));
const op = await until(b.q, m => m.t === 'op');
assert.equal(op.from, wa.id);
const jwt = await signJWT({ sub: 'gitlab:h:1', login: 'ada' }, SECRET, 600);
const put = await fetch(base + '/api/collab/e2e', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt }, body: JSON.stringify({ title: 'from http', nodes: {} }) });
assert.equal(put.status, 200);
const c = await open(ws + '/api/collab/e2e');
const wc = await until(c.q, m => m.t === 'welcome');
assert.equal(wc.snapshot.title, 'from http');
assert.equal(wc.peers.length, 2);
a.c.close(); b.c.close(); c.c.close();
srv.close(); storage.close();
console.log('e2e ok');
