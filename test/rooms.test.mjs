// test/rooms.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRooms } from '../rooms.js';

// Fake sockets and storage: the relay logic is what's under test, not I/O.
class FakeWs extends EventEmitter { constructor() { super(); this.sent = []; } send(t) { this.sent.push(JSON.parse(t)); } }
function memStorage() {
  const rooms = new Map();
  return { room(id) { if (!rooms.has(id)) rooms.set(id, new Map()); const m = rooms.get(id);
    return { async get(k) { return m.get(k); }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; } };
}
const last = ws => ws.sent[ws.sent.length - 1];

describe('rooms', () => {
  test('welcome carries id, colour, stored snapshot and the peers already present; join is broadcast', async () => {
    const st = memStorage(); await st.room('r').put('snapshot', { title: 'S' });
    const rooms = createRooms(st);
    const a = new FakeWs(), b = new FakeWs();
    await rooms.join('r', a);
    assert.equal(a.sent[0].t, 'welcome'); assert.match(a.sent[0].id, /^[0-9a-f]{8}$/);
    assert.deepEqual(a.sent[0].snapshot, { title: 'S' }); assert.deepEqual(a.sent[0].peers, []);
    await rooms.join('r', b);
    assert.deepEqual(b.sent[0].peers, [{ id: a.sent[0].id, color: a.sent[0].color, name: '' }]);
    assert.notEqual(b.sent[0].color, a.sent[0].color, 'colours are unique while any are free');
    assert.deepEqual(last(a), { t: 'join', id: b.sent[0].id, color: b.sent[0].color });
    assert.equal(rooms.size(), 1);
  });

  test('ops and cursors are relayed to the others, tagged with the sender; never echoed back', async () => {
    const rooms = createRooms(memStorage());
    const a = new FakeWs(), b = new FakeWs(), c = new FakeWs();
    await rooms.join('r', a); await rooms.join('r', b); await rooms.join('r', c);
    const before = a.sent.length;
    a.emit('message', JSON.stringify({ t: 'op', ops: [{ t: 'node', id: 'n1', n: { text: 'x' } }] }));
    assert.deepEqual(last(b), { t: 'op', ops: [{ t: 'node', id: 'n1', n: { text: 'x' } }], from: a.sent[0].id });
    assert.deepEqual(last(c), last(b));
    assert.equal(a.sent.length, before, 'sender does not get its own op');
    a.emit('message', JSON.stringify({ t: 'cur', x: 1, y: 2 }));
    assert.equal(last(b).t, 'cur'); assert.equal(last(b).from, a.sent[0].id);
  });

  test('a snapshot is stored opaquely and NOT relayed; a name is stored, truncated to 40 chars and broadcast', async () => {
    const st = memStorage(); const rooms = createRooms(st);
    const a = new FakeWs(), b = new FakeWs();
    await rooms.join('r', a); await rooms.join('r', b);
    const before = b.sent.length;
    a.emit('message', JSON.stringify({ t: 'snapshot', map: { title: 'v2', nodes: {} } }));
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(await st.room('r').get('snapshot'), { title: 'v2', nodes: {} });
    assert.equal(b.sent.length, before);
    a.emit('message', JSON.stringify({ t: 'name', name: 'A'.repeat(50) }));
    assert.deepEqual(last(b), { t: 'name', id: a.sent[0].id, name: 'A'.repeat(40) });
    const c = new FakeWs(); await rooms.join('r', c);
    assert.equal(c.sent[0].peers.find(p => p.id === a.sent[0].id).name, 'A'.repeat(40));
  });

  test('leaving broadcasts leave and the room is dropped when empty', async () => {
    const rooms = createRooms(memStorage());
    const a = new FakeWs(), b = new FakeWs();
    await rooms.join('r', a); await rooms.join('r', b);
    a.emit('close', 1000);
    assert.deepEqual(last(b), { t: 'leave', id: a.sent[0].id });
    assert.equal(rooms.size(), 1);
    b.emit('close', 1000);
    assert.equal(rooms.size(), 0);
  });

  test('garbage frames are ignored', async () => {
    const rooms = createRooms(memStorage());
    const a = new FakeWs(), b = new FakeWs();
    await rooms.join('r', a); await rooms.join('r', b);
    const before = b.sent.length;
    a.emit('message', '{not json');
    assert.equal(b.sent.length, before);
  });
});
