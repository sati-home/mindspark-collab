import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// The bundled app is the pinned MindSpark, unmodified. Everything the
// companion needs from the client landed upstream (#50 discovery, #52 forge
// identity, #54 socket identity); these checks make a re-pin to a ref that
// predates any of them fail here instead of at runtime.
const skip = !existsSync('upstream/src/.git') && 'run npm run fetch-upstream first';
const app = () => readFileSync('upstream/src/public/app.js', 'utf8');

test('upstream/src is the pinned ref, pristine', { skip }, () => {
  const pinnedRef = readFileSync('.upstream-ref', 'utf8').trim();
  const head = execSync('git -C upstream/src rev-parse HEAD', { encoding: 'utf8' }).trim();
  assert.ok(head.startsWith(pinnedRef), `upstream/src is at ${head.slice(0, 7)}, not the pinned ${pinnedRef.slice(0, 7)} - run npm run fetch-upstream`);
  const dirty = execSync('git -C upstream/src status --porcelain', { encoding: 'utf8' });
  assert.equal(dirty, '', 'upstream/src is dirty');

  // app.js rewrites this exact directive at serve time to add ALLOWED_INSTANCES.
  // If upstream ever restyles its CSP, the injection silently becomes a no-op and
  // every self-hosted forge fails as an untraceable network error - fail here first.
  const idx = readFileSync('upstream/src/public/index.html', 'utf8');
  assert.ok(idx.includes("connect-src 'self'"),
    "upstream index.html no longer has connect-src 'self'; update the injection in app.js");
});

// Backend discovery (/healthz -> {"mode":"collab"}, one collabBase() resolver,
// the boot awaiting the probe before a #live= join) is upstream since
// MindSpark #50.
test('the pinned upstream discovers this backend by itself', { skip }, () => {
  const src = app();
  assert.match(src, /^function probeHealth\(\)/m, 'upstream probeHealth() missing - pinned ref predates #50?');
  assert.match(src, /^function collabBase\(\)/m, 'upstream collabBase() missing');
  const i = src.indexOf('await probeHealth();');
  const j = src.indexOf('if(await tryEnterLiveSession()) return;');
  assert.ok(i !== -1 && j !== -1 && i < j, 'upstream boot must await probeHealth() before tryEnterLiveSession()');
});

// The identity request naming the forge, access control keyed on the minted
// identity and the collaborator lookup on the signed-in forge are upstream
// since MindSpark #52.
test('the pinned upstream mints the identity for any forge and looks collaborators up there', { skip }, () => {
  const src = app();
  assert.match(src, /forge:CloudStore\.forge&&CloudStore\.forge\.id, instance:CloudStore\.instance\|\|undefined/, 'upstream Session.ensure() does not name the forge - pinned ref predates #52?');
  assert.match(src, /^\s*return collabAvailable\(\) && typeof Session!=='undefined' && !!Session\.id;/m, 'upstream accessControlAvailable() is not keyed on Session.id');
  assert.match(src, /^async function ensureCollabIdentity\(/m, 'upstream ensureCollabIdentity() missing');
  assert.match(src, /^async function _resolveCollaborator\(/m, 'upstream _resolveCollaborator() missing');
});

// The WebSocket carries the identity as ?token= on the upgrade, connect()
// waits for the identity so the URL can carry it, and a #live= join first
// restores a saved forge session - upstream since MindSpark #54. Without it
// every live guest is anonymous and rooms with an access list refuse them.
test('the pinned upstream sends the identity on the live-session upgrade and restores it before joining', { skip }, () => {
  const src = app();
  const ws = src.indexOf('function wsUrl(r)');
  assert.ok(ws !== -1, 'upstream wsUrl() missing');
  assert.ok(src.indexOf("'?token='+encodeURIComponent(Session.jwt)", ws) !== -1, 'upstream wsUrl() must append ?token=<jwt> when signed in - pinned ref predates #54?');
  const connect = src.indexOf('async function connect(roomId, asHost)');
  assert.ok(connect !== -1, 'upstream Collab.connect() must be async');
  assert.ok(src.indexOf('await ensureCollabIdentity()', connect) !== -1, 'upstream connect() must await ensureCollabIdentity()');
  const live = src.indexOf('async function tryEnterLiveSession');
  assert.ok(live !== -1, 'upstream tryEnterLiveSession() missing');
  const restore = src.indexOf('await CloudStore.tryInit()', live);
  const ident = src.indexOf('await ensureCollabIdentity()', live);
  const join = src.indexOf('Collab.join(room)', live);
  assert.ok(restore !== -1 && ident !== -1 && join !== -1 && restore < ident && ident < join,
    'upstream tryEnterLiveSession() must restore the session, ask for an identity, then join');
});
