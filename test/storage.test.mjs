import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/collab/storage.js';

const dirs = [];
const tmpFile = () => { const d = mkdtempSync(join(tmpdir(), 'msc-')); dirs.push(d); return join(d, 'collab.db'); };

describe('storage', () => {
  after(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));

  test('get of a missing key is undefined, like Durable Object storage', async () => {
    const s = openStorage(tmpFile());
    assert.equal(await s.room('r1').get('acl'), undefined);
    s.close();
  });

  test('put/get round-trips JSON values per room', async () => {
    const s = openStorage(tmpFile());
    const a = s.room('r1'), b = s.room('r2');
    await a.put('snapshot', { nodes: { n1: { text: 'Café ☕' } }, title: 'x' });
    await a.put('acl', { ownerId: 'gitlab:h:1', members: {} });
    assert.deepEqual(await a.get('snapshot'), { nodes: { n1: { text: 'Café ☕' } }, title: 'x' });
    assert.equal(await b.get('snapshot'), undefined, 'rooms are isolated');
    await a.put('acl', { ownerId: 'gitlab:h:1', members: { u: { role: 'viewer' } } });
    assert.deepEqual((await a.get('acl')).members, { u: { role: 'viewer' } }, 'put replaces');
    await a.delete('acl');
    assert.equal(await a.get('acl'), undefined);
    s.close();
  });

  test('values survive closing and reopening the file', async () => {
    const f = tmpFile();
    const s1 = openStorage(f); await s1.room('r').put('editToken', 'tok'); s1.close();
    const s2 = openStorage(f); assert.equal(await s2.room('r').get('editToken'), 'tok'); s2.close();
  });
});

// A value that is not JSON (a hand edit, a truncated write) must not turn a
// room's every read into a 500 and every join into a 1011: it reads as
// absent, and the operator gets one line saying which key.
import { DatabaseSync } from 'node:sqlite';
describe('storage: corrupt values', () => {
  after(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));
  test('a corrupt stored value reads as undefined and is logged; the room keeps working', async () => {
    const file = tmpFile();
    const s = openStorage(file);
    await s.room('r1').put('acl', { ownerId: 'x' });
    const db = new DatabaseSync(file);
    db.prepare("UPDATE room_kv SET value = '{not json' WHERE room = 'r1' AND key = 'acl'").run(); db.close();
    const warned = []; const orig = console.warn; console.warn = (...a) => warned.push(a.join(' '));
    try { assert.equal(await s.room('r1').get('acl'), undefined); } finally { console.warn = orig; }
    assert.equal(warned.length, 1); assert.match(warned[0], /acl/); assert.doesNotMatch(warned[0], /not json/, 'the corrupt payload itself is not logged');
    await s.room('r1').put('acl', { ownerId: 'y' });
    assert.deepEqual(await s.room('r1').get('acl'), { ownerId: 'y' }, 'a put repairs it');
    s.close();
  });
});
