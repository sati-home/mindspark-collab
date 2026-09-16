// Resource limits for unauthenticated callers. Three small mechanisms, all
// in memory, all with injectable time so they can be tested exactly:
//   - a token bucket per key (an IP), for requests that cost storage or a
//     forge round-trip;
//   - caps on live WebSocket sockets, in total and per room;
//   - a reaper for sockets that go silent (the client pings every 6 s, so a
//     minute of silence is a dead or hostile peer).
// None of this replaces a reverse proxy's rate limiting - it is the floor that
// keeps one client from taking the whole process down when there is none.
export function createLimits({
  ratePerMin = 60, burst = 30,
  maxSockets = 500, maxSocketsPerRoom = 32,
  idleMs = 60_000,
  now = Date.now,
} = {}) {
  // ---- token bucket ---------------------------------------------------------
  const buckets = new Map();                        // key -> { tokens, at }
  const perMs = ratePerMin / 60_000;
  const SWEEP_EVERY = 1000, STALE_MS = 5 * 60_000;
  let sinceSweep = 0, lastSweep = now();
  function allow(key) {
    const t = now();
    if (++sinceSweep >= SWEEP_EVERY || t - lastSweep > 60_000) {   // bounded map: drop buckets nobody touched for minutes
      sinceSweep = 0; lastSweep = t;
      for (const [k, b] of buckets) if (t - b.at > STALE_MS) buckets.delete(k);
    }
    let b = buckets.get(key);
    if (!b) { b = { tokens: burst, at: t }; buckets.set(key, b); }
    b.tokens = Math.min(burst, b.tokens + (t - b.at) * perMs); b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1; return true;
  }

  // ---- socket caps ----------------------------------------------------------
  const perRoom = new Map();                        // room -> count
  let total = 0;
  function acquire(room) {
    const n = perRoom.get(room) || 0;
    if (total >= maxSockets || n >= maxSocketsPerRoom) return false;
    perRoom.set(room, n + 1); total += 1; return true;
  }
  function release(room) {
    const n = perRoom.get(room) || 0;
    if (n <= 0) return;
    if (n === 1) perRoom.delete(room); else perRoom.set(room, n - 1);
    total -= 1;
  }

  // ---- idle reaper ----------------------------------------------------------
  const watched = new Map();                        // ws -> lastSeen
  function watch(ws) {
    watched.set(ws, now());
    ws.on('message', () => { if (watched.has(ws)) watched.set(ws, now()); });
    ws.on('close', () => watched.delete(ws));
  }
  function reap() {
    const t = now();
    for (const [ws, seen] of watched) {
      if (t - seen > idleMs) { watched.delete(ws); try { ws.close(1001); } catch {} }
    }
  }

  return {
    allow, bucketCount: () => buckets.size,
    acquire, release, counts: () => ({ total, rooms: Object.fromEntries(perRoom) }),
    watch, reap, watched: () => watched.size,
    idleMs,
  };
}
