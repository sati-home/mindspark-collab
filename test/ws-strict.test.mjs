// RFC 6455 strictness the browser client never exercises but a hostile peer
// can: the version must be negotiated, reserved bits must be zero (1002), and
// a text frame must be valid UTF-8 (1007). Frames are hand-built over a raw
// socket because no client library sends malformed ones.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { acceptUpgrade } from '../src/collab/ws.js';

const socks = [];

function server() {
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  srv.on('upgrade', (req, socket, head) => { const ws = acceptUpgrade(req, socket, head); if (ws) ws.on('message', t => ws.send(t)); });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port })));
}
// Handshake by hand; resolves with the socket and the raw response head.
function handshake(port, { version = '13' } = {}) {
  return new Promise((ok, fail) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      socks.push(sock);
      sock.write('GET /r HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + (version ? 'Sec-WebSocket-Version: ' + version + '\r\n' : '') + '\r\n');
    });
    let head = '';
    const onData = d => { head += d; if (head.includes('\r\n\r\n')) { sock.removeListener('data', onData); ok({ sock, head }); } };
    sock.on('data', onData); sock.on('error', fail);
    sock.on('close', () => ok({ sock, head }));
  });
}
function clientFrame(op, payload, { rsv = 0 } = {}) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload), mask = Buffer.from([7, 8, 9, 10]);
  const m = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) m[i] = p[i] ^ mask[i & 3];
  return Buffer.concat([Buffer.from([0x80 | rsv | op, 0x80 | p.length]), mask, m]);
}
// The next server frame; a close frame yields its code.
const nextFrame = sock => new Promise(res => sock.once('data', d => res({ op: d[0] & 0x0f, code: (d[0] & 0x0f) === 0x8 && d[1] >= 2 ? d.readUInt16BE(2) : null, text: d.subarray(2).toString('utf8') })));

describe('ws strictness', () => {
  const servers = [];
  after(() => { socks.forEach(s => { try { s.destroy(); } catch {} }); servers.forEach(s => { s.closeAllConnections?.(); s.close(); }); });

  test('a missing or foreign Sec-WebSocket-Version is answered 426 naming 13', async () => {
    const { srv, port } = await server(); servers.push(srv);
    for (const version of ['', '8']) {
      const { sock, head } = await handshake(port, { version });
      assert.match(head, /^HTTP\/1\.1 426 /, 'version ' + JSON.stringify(version));
      assert.match(head, /Sec-WebSocket-Version: 13/i);
      sock.destroy();
    }
  });

  test('a frame with a reserved bit set closes with 1002 (no extension was negotiated)', async () => {
    const { srv, port } = await server(); servers.push(srv);
    const { sock, head } = await handshake(port);
    assert.match(head, /^HTTP\/1\.1 101 /);
    sock.write(clientFrame(0x1, 'hi', { rsv: 0x40 }));
    assert.equal((await nextFrame(sock)).code, 1002);
    sock.destroy();
  });

  test('a text frame that is not valid UTF-8 closes with 1007; a valid one still echoes', async () => {
    const { srv, port } = await server(); servers.push(srv);
    const { sock } = await handshake(port);
    sock.write(clientFrame(0x1, 'Café'));
    assert.equal((await nextFrame(sock)).text, 'Café');
    sock.write(clientFrame(0x1, Buffer.from([0xff, 0xfe, 0x41])));
    assert.equal((await nextFrame(sock)).code, 1007);
    sock.destroy();
  });
});
