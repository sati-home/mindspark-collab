// SQLite-backed key/value store, one namespace per room. The per-room adapter
// mirrors the surface upstream's collab-http uses on Durable Object storage:
// get() answers undefined for a missing key, put() replaces. Values are JSON.
import { DatabaseSync } from 'node:sqlite';

export function openStorage(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS room_kv (
      room TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY (room, key));
  `);
  const q = {
    get: db.prepare('SELECT value FROM room_kv WHERE room = ? AND key = ?'),
    put: db.prepare(`INSERT INTO room_kv (room, key, value, updated) VALUES (?, ?, ?, ?)
                     ON CONFLICT(room, key) DO UPDATE SET value = excluded.value, updated = excluded.updated`),
    del: db.prepare('DELETE FROM room_kv WHERE room = ? AND key = ?'),
  };
  return {
    room(id) {
      return {
        // A value that fails to parse (a hand edit, a truncated write) reads as
        // absent rather than failing every read of the room; the next put
        // repairs it. Key only in the log - room ids are capabilities.
        async get(key) {
          const r = q.get.get(id, key); if (!r) return undefined;
          try { return JSON.parse(r.value); }
          catch { console.warn(`storage: corrupt value for key=${key}, treated as absent`); return undefined; }
        },
        async put(key, value) { q.put.run(id, key, JSON.stringify(value), Date.now()); },
        async delete(key) { q.del.run(id, key); },
      };
    },
    close() { db.close(); },
  };
}
