import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { acceptUpgrade } from '../ws.js';

// An echo server built on the module under test; Node's built-in WebSocket is the client.
function echoServer(opts) {
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  srv.on('upgrade', (req, socket, head) => {
    const ws = acceptUpgrade(req, socket, head, opts);
    if (!ws) return;
    ws.on('message', t => ws.send(t));
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ srv, url: `ws://127.0.0.1:${srv.address().port}/x` })));
}
const open = url => new Promise((res, rej) => { const c = new WebSocket(url); c.onopen = () => res(c); c.onerror = e => rej(e); });
const next = c => new Promise(res => { c.onmessage = e => res(e.data); });
const closed = c => new Promise(res => { c.onclose = e => res(e.code); });

describe('ws', () => {
  const servers = [];
  after(() => servers.forEach(s => s.close()));

  test('handshake + echo of a short, a 70 kB and a UTF-8 text frame', async () => {
    const { srv, url } = await echoServer(); servers.push(srv);
    const c = await open(url);
    c.send('hello'); assert.equal(await next(c), 'hello');
    const big = 'x'.repeat(70000); c.send(big); assert.equal((await next(c)).length, 70000, '16-bit length path');
    c.send('Café ☕'); assert.equal(await next(c), 'Café ☕');
    c.close();
  });

  test('a frame over the cap closes the connection with 1009', async () => {
    const { srv, url } = await echoServer({ maxFrame: 1000 }); servers.push(srv);
    const c = await open(url);
    const done = closed(c);
    c.send('y'.repeat(2000));
    assert.equal(await done, 1009);
  });

  test('client close is answered and surfaces as a close event', async () => {
    const { srv, url } = await echoServer(); servers.push(srv);
    let serverClosed = null;
    srv.removeAllListeners('upgrade');
    srv.on('upgrade', (req, socket, head) => { const ws = acceptUpgrade(req, socket, head); ws.on('close', code => { serverClosed = code; }); });
    const c = await open(url);
    const done = closed(c);
    c.close(1000);
    assert.equal(await done, 1000);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(serverClosed, 1000);
  });

  test('a non-websocket upgrade is refused with 400 and null', async () => {
    const srv = http.createServer(); servers.push(srv);
    let result = 'unset';
    srv.on('upgrade', (req, socket, head) => { result = acceptUpgrade(req, socket, head); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const status = await new Promise(res => {
      const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'h2c' } });
      req.on('response', r => res(r.statusCode)); req.on('upgrade', () => res('upgraded')); req.end();
    });
    assert.equal(status, 400);
    assert.equal(result, null);
  });
});
