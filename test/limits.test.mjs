// Unauthenticated callers must not be able to exhaust the server: a per-key
// token bucket for requests, caps on live sockets (total and per room), and a
// reaper for sockets that go silent. Time is injected so the tests are exact.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLimits } from '../src/collab/limits.js';

class FakeWs extends EventEmitter { constructor() { super(); this.closedWith = null; } close(code) { this.closedWith = code; this.emit('close', code); } }

describe('limits: token bucket', () => {
  test('allows a burst up to capacity, then refuses until tokens refill', () => {
    let now = 0;
    const L = createLimits({ ratePerMin: 60, burst: 3, now: () => now });
    assert.deepEqual([L.allow('a'), L.allow('a'), L.allow('a'), L.allow('a')], [true, true, true, false]);
    assert.equal(L.allow('b'), true, 'keys are independent');
    now = 1000;                                   // 1 s later: 60/min = 1 token
    assert.equal(L.allow('a'), true);
    assert.equal(L.allow('a'), false);
    now = 61000;                                  // a full minute: back to the burst cap, not more
    assert.deepEqual([L.allow('a'), L.allow('a'), L.allow('a'), L.allow('a')], [true, true, true, false]);
  });

  test('idle buckets are forgotten so the map cannot grow without bound', () => {
    let now = 0;
    const L = createLimits({ ratePerMin: 60, burst: 1, now: () => now });
    for (let i = 0; i < 1000; i++) L.allow('k' + i);
    assert.equal(L.bucketCount(), 1000);
    now = 10 * 60 * 1000;
    L.allow('fresh');
    assert.equal(L.bucketCount(), 1, 'buckets untouched for minutes are dropped on the next call');
  });
});

describe('limits: sockets', () => {
  test('caps sockets per room and in total; release frees a slot', () => {
    const L = createLimits({ maxSockets: 3, maxSocketsPerRoom: 2 });
    assert.equal(L.acquire('r1'), true); assert.equal(L.acquire('r1'), true);
    assert.equal(L.acquire('r1'), false, 'room cap');
    assert.equal(L.acquire('r2'), true);
    assert.equal(L.acquire('r3'), false, 'total cap');
    L.release('r1');
    assert.equal(L.acquire('r3'), true);
    assert.deepEqual(L.counts(), { total: 3, rooms: { r1: 1, r2: 1, r3: 1 } });
    L.release('r2'); L.release('r2');
    assert.equal(L.counts().rooms.r2, undefined, 'release never goes negative and drops empty rooms');
  });

  test('a socket silent for longer than idleMs is closed 1001; activity resets the clock', () => {
    let now = 0;
    const L = createLimits({ idleMs: 1000, now: () => now });
    const a = new FakeWs(), b = new FakeWs();
    L.watch(a); L.watch(b);
    now = 800; a.emit('message', '{"t":"ping"}');
    now = 1100; L.reap();
    assert.equal(b.closedWith, 1001, 'b was silent for 1.1 s');
    assert.equal(a.closedWith, null, 'a spoke at 0.8 s');
    now = 1900; L.reap();
    assert.equal(a.closedWith, 1001);
    assert.equal(L.watched(), 0, 'closed sockets leave the watch set');
  });
});
