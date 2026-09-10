// A deliberately small RFC 6455 server: text frames, close, ping/pong.
// No extensions, no fragmentation (a fragmented frame closes with 1003),
// masked client frames only (unmasked ones close with 1002). The browser
// client only ever sends short JSON text, so this is all the contract needs.
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class ServerSocket extends EventEmitter {
  constructor(socket, maxFrame) {
    super();
    this.socket = socket; this.maxFrame = maxFrame; this.buf = Buffer.alloc(0); this.closed = false;
    socket.on('data', d => this._onData(d));
    socket.on('close', () => this._finish(1006));
    socket.on('error', () => this._finish(1006));
  }
  send(text) { if (!this.closed) this.socket.write(frame(0x1, Buffer.from(String(text), 'utf8'))); }
  close(code = 1000) {
    if (this.closed) return;
    const wire = Number.isInteger(code) && code >= 1000 && code <= 4999
      && code !== 1004 && code !== 1005 && code !== 1006 ? code : 1000;
    const b = Buffer.alloc(2); b.writeUInt16BE(wire);
    try { this.socket.write(frame(0x8, b)); } catch {}
    this.socket.end(); this._finish(wire);
  }
  _finish(code) { if (this.closed) return; this.closed = true; this.emit('close', code); }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.closed) return;
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > this.maxFrame) return this.close(1009);
      if (!masked) return this.close(1002);
      if (!fin || op === 0x0) return this.close(1003);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x1) this.emit('message', payload.toString('utf8'));
      else if (op === 0x8) { this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1005); return; }
      else if (op === 0x9) this.socket.write(frame(0xA, payload));
      // 0xA pong and 0x2 binary: ignored.
    }
  }
}

function frame(op, payload) {
  let head;
  if (payload.length < 126) { head = Buffer.from([0x80 | op, payload.length]); }
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, payload]);
}

export function acceptUpgrade(req, socket, head, { maxFrame = 1024 * 1024 } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy();
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + 'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const ws = new ServerSocket(socket, maxFrame);
  if (head && head.length) ws._onData(head);
  return ws;
}
