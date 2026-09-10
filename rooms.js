// One room per map id while anyone is connected. A dependency-free RELAY, the
// same as upstream's Durable Object: it broadcasts ops/cursors/presence between
// sockets, stores one opaque latest snapshot so a late joiner can sync, and
// never interprets the map itself.
import { randomUUID } from 'node:crypto';

const COLORS = ['#e0613a', '#3a6ea5', '#2e9e6b', '#9a5bb8', '#d0902e', '#c14d7a', '#1f8a8a', '#b8513a'];

export function createRooms(storage) {
  const rooms = new Map();   // id -> { sockets: Map<ws, {id, color, name}> }

  const room = id => { let r = rooms.get(id); if (!r) { r = { sockets: new Map() }; rooms.set(id, r); } return r; };
  const peers = (r, except) => [...r.sockets].filter(([w]) => w !== except).map(([, a]) => ({ id: a.id, color: a.color, name: a.name || '' }));
  const broadcast = (r, sender, data) => { const s = JSON.stringify(data); for (const [w] of r.sockets) { if (w === sender) continue; try { w.send(s); } catch {} } };

  async function join(roomId, ws) {
    const r = room(roomId);
    const taken = new Set([...r.sockets.values()].map(a => a.color));
    const color = COLORS.find(c => !taken.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
    const me = { id: randomUUID().slice(0, 8), color, name: '' };
    r.sockets.set(ws, me);
    const store = storage.room(roomId);

    const snapshot = await store.get('snapshot');
    ws.send(JSON.stringify({ t: 'welcome', id: me.id, color, snapshot: snapshot || null, peers: peers(r, ws) }));
    broadcast(r, ws, { t: 'join', id: me.id, color });

    ws.on('message', async text => {
      let m; try { m = JSON.parse(text); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'snapshot') { await store.put('snapshot', m.map); return; }          // stored opaquely, not relayed
      if (m.t === 'name') { me.name = String(m.name || '').slice(0, 40); broadcast(r, ws, { t: 'name', id: me.id, name: me.name }); return; }
      m.from = me.id;                                                                   // tag, relay to the others
      broadcast(r, ws, m);
    });
    ws.on('close', () => {
      r.sockets.delete(ws);
      broadcast(r, ws, { t: 'leave', id: me.id });
      if (r.sockets.size === 0) rooms.delete(roomId);
    });
  }
  return { join, size: () => rooms.size };
}
