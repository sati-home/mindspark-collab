import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../storage.js';

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
