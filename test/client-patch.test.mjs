import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// The patch is the proposed upstream change; it must keep applying to the
// pinned ref, and it must touch nothing but the client.
test('client patch applies cleanly to the pinned upstream ref', { skip: !existsSync('upstream/src/.git') && 'run npm run fetch-upstream first' }, () => {
  const pinnedRef = readFileSync('.upstream-ref', 'utf8').trim();
  const head = execSync('git -C upstream/src rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  assert.ok(pinnedRef.startsWith(head) || head.startsWith(pinnedRef),
    'upstream/src is not at the pinned ref — run npm run fetch-upstream');
  const dirty = execSync('git -C upstream/src status --porcelain', { encoding: 'utf8' });
  assert.equal(dirty, '', 'upstream/src is dirty');

  const patch = readFileSync('docker/client-collab.patch', 'utf8');
  assert.match(patch, /^diff --git a\/public\/app\.js b\/public\/app\.js/m);
  assert.equal((patch.match(/^diff --git/gm) || []).length, 1, 'only app.js');
  execSync('git apply --check ../../docker/client-collab.patch', { cwd: 'upstream/src', stdio: 'pipe' });

  // app.js rewrites this exact directive at serve time to add ALLOWED_INSTANCES.
  // If upstream ever restyles its CSP, the injection silently becomes a no-op and
  // every self-hosted forge fails as an untraceable network error - fail here first.
  const idx = readFileSync('upstream/src/public/index.html', 'utf8');
  assert.ok(idx.includes("connect-src 'self'"),
    "upstream index.html no longer has connect-src 'self'; update the injection in app.js");
});

// Backend discovery (/healthz -> {"mode":"collab"}, one collabBase() resolver,
// the boot awaiting the probe before a #live= join) is upstream since
// MindSpark #50. The pinned upstream must have it, and the patch must not
// carry it again.
test('the pinned upstream discovers this backend by itself', { skip: !existsSync('upstream/src/.git') && 'run npm run fetch-upstream first' }, () => {
  const app = readFileSync('upstream/src/public/app.js', 'utf8');
  assert.match(app, /^function probeHealth\(\)/m, 'upstream probeHealth() missing - pinned ref predates #50?');
  assert.match(app, /^function collabBase\(\)/m, 'upstream collabBase() missing');
  const i = app.indexOf('await probeHealth();');
  const j = app.indexOf('if(await tryEnterLiveSession()) return;');
  assert.ok(i !== -1 && j !== -1 && i < j, 'upstream boot must await probeHealth() before tryEnterLiveSession()');
  const patch = readFileSync('docker/client-collab.patch', 'utf8');
  assert.doesNotMatch(patch, /^\+function probeHealth\(\)/m, 'the patch must not re-add probeHealth()');
  assert.doesNotMatch(patch, /^\+function collabBase\(\)/m, 'the patch must not re-add collabBase()');
});

// The identity request naming the forge, access control keyed on the minted
// identity and the collaborator lookup on the signed-in forge are upstream
// since MindSpark #52. The pinned upstream must have them, and the patch must
// not carry them again.
test('the pinned upstream mints the identity for any forge and looks collaborators up there', { skip: !existsSync('upstream/src/.git') && 'run npm run fetch-upstream first' }, () => {
  const app = readFileSync('upstream/src/public/app.js', 'utf8');
  assert.match(app, /forge:CloudStore\.forge&&CloudStore\.forge\.id, instance:CloudStore\.instance\|\|undefined/, 'upstream Session.ensure() does not name the forge - pinned ref predates #52?');
  assert.match(app, /^\s*return collabAvailable\(\) && typeof Session!=='undefined' && !!Session\.id;/m, 'upstream accessControlAvailable() is not keyed on Session.id');
  assert.match(app, /^async function ensureCollabIdentity\(/m, 'upstream ensureCollabIdentity() missing');
  assert.match(app, /^async function _resolveCollaborator\(/m, 'upstream _resolveCollaborator() missing');
  const patch = readFileSync('docker/client-collab.patch', 'utf8');
  assert.doesNotMatch(patch, /^\+.*forge:CloudStore\.forge&&CloudStore\.forge\.id/m, 'the patch must not re-add the forge in the identity request');
  assert.doesNotMatch(patch, /^\+async function ensureCollabIdentity\(/m, 'the patch must not re-add ensureCollabIdentity()');
  assert.doesNotMatch(patch, /^\+async function _resolveCollaborator\(/m, 'the patch must not re-add _resolveCollaborator()');
  assert.doesNotMatch(patch, /^\+.*userUrl\(r, login\)/m, 'the patch must not re-add the FORGES lookup pair');
});

// The WebSocket carries the identity as ?token= on the upgrade, and a live
// join first restores the session and asks for an identity - otherwise every
// live guest is anonymous and rooms with an access list refuse them.
test('the patch sends the identity on the live-session upgrade and restores it before joining', () => {
  const patch = readFileSync('docker/client-collab.patch', 'utf8');
  assert.match(patch, /\?token='\+encodeURIComponent\(Session\.jwt\)/, 'wsUrl must append ?token=<jwt> when signed in');
  const live = patch.indexOf('async function tryEnterLiveSession');
  assert.ok(live !== -1 && patch.indexOf('await ensureCollabIdentity()', live) !== -1, 'tryEnterLiveSession must await ensureCollabIdentity()');
  assert.ok(patch.indexOf('await CloudStore.tryInit()', live) !== -1, 'tryEnterLiveSession must restore a saved session first');
});
