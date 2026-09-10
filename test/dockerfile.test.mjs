// The Dockerfile copies an explicit list of modules. A module added to the
// server but not to that list builds fine and then fails at boot inside the
// container - so the list is checked against what server.js actually imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function localImports(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/from\s+'\.\/([^']+)'/g)) if (!m[1].startsWith('upstream/')) localImports(m[1], seen);
  return seen;
}

test('every local module server.js needs is copied into the image', () => {
  const needed = [...localImports('server.js')];
  const dockerfile = readFileSync('docker/Dockerfile', 'utf8');
  const copied = new Set(dockerfile.split('\n').filter(l => /^COPY\s/.test(l) && !/--from=/.test(l)).flatMap(l => l.replace(/^COPY\s+/, '').split(/\s+/)));
  for (const f of needed) assert.ok(copied.has(f), `${f} is imported by the server but not COPYed in docker/Dockerfile`);
});
