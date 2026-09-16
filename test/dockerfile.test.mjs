// The Dockerfile copies the server's sources explicitly. A module added to the
// server but left out of those COPY lines builds fine and then fails at boot
// inside the container - so what server.js actually imports (transitively) is
// checked against what the Dockerfile copies, a file or any directory above it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ENTRY = 'src/collab/server.js';

function localImports(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
    const target = normalize(join(dirname(file), m[1]));
    if (!target.startsWith('upstream/')) localImports(target, seen);
  }
  return seen;
}

test('every local module server.js needs is copied into the image', () => {
  const needed = [...localImports(ENTRY)];
  assert.ok(needed.length > 1, 'server.js imports nothing local? the import scan is broken');
  const dockerfile = readFileSync('docker/Dockerfile', 'utf8');
  const copied = dockerfile.split('\n').filter(l => /^COPY\s/.test(l) && !/--from=/.test(l))
    .flatMap(l => l.replace(/^COPY\s+/, '').split(/\s+/).slice(0, -1));   // the last word is the destination
  const covered = f => copied.some(c => c === f || f.startsWith(c.replace(/\/$/, '') + '/'));
  for (const f of needed) assert.ok(covered(f), `${f} is imported by the server but not COPYed in docker/Dockerfile`);
  const cmd = dockerfile.match(/^CMD\s+(.*)$/m); assert.ok(cmd && cmd[1].includes(ENTRY), 'CMD must start ' + ENTRY);
  assert.ok(covered(ENTRY), ENTRY + ' itself must be copied');
});
