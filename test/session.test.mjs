import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../session.js';
import { verifyJWT } from '../upstream/auth-core.js';

// A fake forge: answers the user endpoint for one token, 401 otherwise.
function forgeNet(expect) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {} });
    const hit = expect.find(e => e.url === url && e.auth === (opts.headers || {}).Authorization);
    if (!hit) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit.user };
  };
  return { calls, fetchImpl };
}
const SECRET = 'test-secret';
const mk = (net, extra = {}) => createSession({ secret: SECRET, allowedInstances: ['https://gitlab.example', 'https://codeberg.org'], fetchImpl: net.fetchImpl, ...extra });

describe('session endpoint', () => {
  test('GitLab: verifies against <instance>/api/v4/user with Bearer, mints a namespaced identity', async () => {
    const net = forgeNet([{ url: 'https://gitlab.example/api/v4/user', auth: 'Bearer glpat-x', user: { id: 7, username: 'ada', name: 'Ada' } }]);
    const r = await mk(net)({ forge: 'gitlab', instance: 'https://gitlab.example/', token: 'glpat-x' });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 'gitlab:gitlab.example:7');
    assert.equal(r.body.login, 'ada');
    const p = await verifyJWT(r.body.token, SECRET);
    assert.equal(p.sub, 'gitlab:gitlab.example:7');
    assert.equal(p.login, 'ada');
    assert.ok(p.exp > Math.floor(Date.now() / 1000) + 43000 && p.exp <= Math.floor(Date.now() / 1000) + 43200);
    assert.equal(r.body.exp, p.exp);
  });

  test('Gitea: /api/v1/user with the `token` scheme, login from `login`', async () => {
    const net = forgeNet([{ url: 'https://codeberg.org/api/v1/user', auth: 'token t1', user: { id: 9, login: 'bob' } }]);
    const r = await mk(net)({ forge: 'gitea', instance: 'https://codeberg.org', token: 't1' });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 'gitea:codeberg.org:9');
  });

  test('GitHub: api.github.com, no instance needed; a body with only {token} means GitHub (compat)', async () => {
    const net = forgeNet([{ url: 'https://api.github.com/user', auth: 'Bearer ghp', user: { id: 1, login: 'ada' } }]);
    const r = await mk(net)({ token: 'ghp' });
    assert.equal(r.status, 200);
    assert.equal(r.body.id, 'github:github.com:1');
    assert.equal(net.calls[0].headers['User-Agent'], 'mindspark-collab', 'GitHub rejects requests without a User-Agent');
  });

  test('an instance outside the allowlist is refused before any request is made, and the refusal is logged', async () => {
    const net = forgeNet([]);
    const warnings = [];
    const orig = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    let r;
    try { r = await mk(net)({ forge: 'gitlab', instance: 'https://evil.example', token: 'x' }); }
    finally { console.warn = orig; }
    assert.equal(r.status, 403);
    assert.equal(net.calls.length, 0, 'the endpoint must not be an open proxy');
    assert.equal(warnings.length, 1, 'an operator must be able to see why a sign-in was refused');
    assert.match(warnings[0], /gitlab/);
    assert.match(warnings[0], /evil\.example/);
    assert.match(warnings[0], /403/);
    assert.doesNotMatch(warnings[0], /\bx\b/, 'never log the token');
  });

  test('a rejected token is 401, an unreachable forge 502, a missing token 400, an unknown forge 400', async () => {
    const net = forgeNet([]);
    assert.equal((await mk(net)({ forge: 'gitlab', instance: 'https://gitlab.example', token: 'bad' })).status, 401);
    const down = createSession({ secret: SECRET, allowedInstances: ['https://gitlab.example'], fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal((await down({ forge: 'gitlab', instance: 'https://gitlab.example', token: 'x' })).status, 502);
    assert.equal((await mk(net)({ forge: 'gitlab', instance: 'https://gitlab.example' })).status, 400);
    assert.equal((await mk(net)({ forge: 'svn', token: 'x' })).status, 400);
    const proto = await mk(net)({ forge: '__proto__', token: 'x' });
    assert.equal(proto.status, 400, 'inherited keys are not forges');
    assert.equal(proto.body.error, 'unknown forge');
    assert.equal((await mk(net)({ forge: 'constructor', token: 'x' })).status, 400);
  });

  test('without a secret the endpoint answers 501, which the client treats as "identity off"', async () => {
    const net = forgeNet([]);
    const r = await createSession({ secret: '', allowedInstances: [], fetchImpl: net.fetchImpl })({ token: 'x' });
    assert.equal(r.status, 501);
  });
});
