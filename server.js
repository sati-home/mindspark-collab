// Entry point. Configuration is environment only; a missing AUTH_SECRET is
// fatal on purpose - running with identity silently off would look like it
// works while every access-control feature quietly refuses.
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createApp } from './app.js';
import { openStorage } from './storage.js';
import { createSession } from './session.js';

export function configFromEnv(env = process.env) {
  const here = dirname(fileURLToPath(import.meta.url));
  const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  const port = Number(env.PORT || 3000);
  const cfg = {
    port,
    dataDir: env.DATA_DIR || join(here, 'data'),
    authSecret: env.AUTH_SECRET || '',
    allowedInstances: list(env.ALLOWED_INSTANCES),
    allowedOrigin: (env.ALLOWED_ORIGIN || '').replace(/\/+$/, ''),
    publicDir: env.PUBLIC_DIR || join(here, 'upstream', 'public'),
  };
  if (!cfg.authSecret) throw new Error('AUTH_SECRET is required (generate one: openssl rand -hex 32)');
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error('PORT must be an integer between 1 and 65535');
  for (const o of cfg.allowedInstances) { let u; try { u = new URL(o); } catch { throw new Error('ALLOWED_INSTANCES: not an origin: ' + o); } if (u.origin !== o) throw new Error('ALLOWED_INSTANCES: use bare origins: ' + o); }
  return cfg;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let cfg; try { cfg = configFromEnv(); } catch (e) { console.error(e.message); process.exit(1); }
  mkdirSync(cfg.dataDir, { recursive: true });
  const storage = openStorage(join(cfg.dataDir, 'collab.db'));
  const session = createSession({ secret: cfg.authSecret, allowedInstances: cfg.allowedInstances });
  const server = createApp({ ...cfg, storage, session });
  server.listen(cfg.port, () => console.log(`mindspark-collab on http://localhost:${cfg.port} (app: ${cfg.publicDir}, data: ${cfg.dataDir}, instances: ${cfg.allowedInstances.join(', ') || 'none'})`));
  // Drain in-flight requests before closing storage: a bare server.close() +
  // storage.close() in the same tick can race a handler still reading/writing
  // SQLite. The timer is a fallback in case a connection never finishes (e.g.
  // a stuck keep-alive or an open WebSocket) so shutdown is still bounded.
  const stop = () => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); try { storage.close(); } catch {} process.exit(0); };
    server.close(finish);
    const timer = setTimeout(finish, 5000);
    timer.unref();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
