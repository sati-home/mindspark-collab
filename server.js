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
  const cfg = {
    port: Number(env.PORT || 3000),
    dataDir: env.DATA_DIR || join(here, 'data'),
    authSecret: env.AUTH_SECRET || '',
    allowedInstances: list(env.ALLOWED_INSTANCES),
    allowedOrigin: (env.ALLOWED_ORIGIN || '').replace(/\/+$/, ''),
    publicDir: env.PUBLIC_DIR || join(here, 'upstream', 'public'),
  };
  if (!cfg.authSecret) throw new Error('AUTH_SECRET is required (generate one: openssl rand -hex 32)');
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
  const stop = () => { server.close(); storage.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
