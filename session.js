// Turn a forge token into the signed identity the collab API expects.
// The token is used for ONE request to the forge's user endpoint and dropped.
// The subject is namespaced by forge and host so ids from different forges
// (GitHub id 1 vs GitLab id 1) can never be the same person by accident.
import { signJWT, verifyJWT } from './upstream/auth-core.js';

const strip = s => String(s || '').replace(/\/+$/, '');

export const FORGES = {
  github: {
    host: () => 'github.com',
    userUrl: () => 'https://api.github.com/user',
    headers: t => ({ Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json', 'User-Agent': 'mindspark-collab' }),
    normalize: u => (u && u.id != null && u.login) ? { id: String(u.id), login: u.login } : null,
  },
  gitea: {
    host: i => new URL(i).host,
    userUrl: i => strip(i) + '/api/v1/user',
    headers: t => ({ Authorization: 'token ' + t, Accept: 'application/json' }),
    normalize: u => (u && u.id != null && u.login) ? { id: String(u.id), login: u.login } : null,
  },
  gitlab: {
    host: i => new URL(i).host,
    userUrl: i => strip(i) + '/api/v4/user',
    headers: t => ({ Authorization: 'Bearer ' + t, Accept: 'application/json' }),
    normalize: u => (u && u.id != null && u.username) ? { id: String(u.id), login: u.username } : null,
  },
};

// The instance host, never the URL: a self-hosted origin may embed credentials.
const hostOf = instance => { if (!instance) return 'github.com'; try { return new URL(instance).host; } catch { return 'unparseable'; } };
const errCode = err => String((err && (err.code || err.name)) || 'unknown');

export function createSession({ secret, allowedInstances = [], fetchImpl = fetch, ttlSec = 12 * 60 * 60 }) {
  const allowed = new Set(allowedInstances.map(strip));
  return async function session(body) {
    if (!secret) return { status: 501, body: { error: 'identity not configured' } };
    const forgeId = (body && body.forge) || 'github';
    // hasOwn, not a bare lookup: 'constructor' and '__proto__' are truthy on
    // any object literal and would otherwise sail past this check.
    if (!Object.hasOwn(FORGES, forgeId)) return { status: 400, body: { error: 'unknown forge' } };
    const forge = FORGES[forgeId];
    const token = body && body.token;
    if (!token) return { status: 400, body: { error: 'token required' } };

    let instance = null;
    if (forgeId !== 'github') {
      instance = strip(body.instance);
      let origin; try { origin = new URL(instance).origin; } catch { return { status: 400, body: { error: 'instance must be an origin' } }; }
      if (origin !== instance || !allowed.has(origin)) {
        // One line an operator can grep for: the usual cause is an instance
        // missing from ALLOWED_INSTANCES, and silence made that look like a
        // client bug. Host only - the instance URL may carry credentials.
        console.warn(`session: refused instance forge=${forgeId} host=${hostOf(instance)} status=403`);
        return { status: 403, body: { error: 'instance not allowed' } };
      }
    }

    let user;
    try {
      const r = await fetchImpl(forge.userUrl(instance), { headers: forge.headers(token) });
      if (!r.ok) return { status: 401, body: { error: 'invalid token' } };
      user = await r.json();
    } catch (err) {
      // Covers both a dead forge and one that answered something that is not
      // JSON (a captive portal, an HTML error page). Never the token.
      console.warn(`session: forge unreachable forge=${forgeId} host=${hostOf(instance)} status=502 error=${errCode(err)}`);
      return { status: 502, body: { error: 'forge unreachable' } };
    }

    const me = forge.normalize(user);
    if (!me) return { status: 401, body: { error: 'no identity' } };
    const sub = `${forgeId}:${forge.host(instance)}:${me.id}`;
    const jwt = await signJWT({ sub, login: me.login }, secret, ttlSec);
    // Read exp back from the token we just minted so the response body and the
    // JWT agree exactly, instead of hoping two Date.now() calls land in the
    // same second.
    const { exp } = await verifyJWT(jwt, secret);
    return { status: 200, body: { token: jwt, exp, id: sub, login: me.login } };
  };
}
