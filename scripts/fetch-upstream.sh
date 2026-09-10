#!/bin/sh
# Pull the pinned MindSpark sources this companion runs against.
#   sh scripts/fetch-upstream.sh [ref] [--patch]
# ref     : tag, branch or commit (default: the one in .upstream-ref)
# --patch : also apply docker/client-collab.patch to upstream/public (demo build)
set -eu
cd "$(dirname "$0")/.."
REF="${1:-$(cat .upstream-ref)}"
PATCH=""; [ "${2:-}" = "--patch" ] && PATCH=1
REPO="https://github.com/prasadpatil25/MindSpark.git"

rm -rf upstream && mkdir -p upstream/src test/upstream
git clone -q "$REPO" upstream/src
git -C upstream/src checkout -q "$REF"
echo "upstream: $(git -C upstream/src rev-parse --short HEAD)"

cp -R upstream/src/public upstream/public
cp upstream/src/worker/auth-core.js upstream/src/worker/collab-http.js upstream/
# Upstream's own test for the authorization core, re-pointed at our copy.
sed "s#'../worker/auth-core.js'#'../../upstream/auth-core.js'#" \
  upstream/src/test/auth-core.test.mjs > test/upstream/auth-core.test.mjs

if [ -n "$PATCH" ]; then
  git -C upstream/src apply --check "$PWD/docker/client-collab.patch"
  git -C upstream/src apply "$PWD/docker/client-collab.patch"
  rm -rf upstream/public && cp -R upstream/src/public upstream/public
  # Restore the scratch checkout to pristine so it stays an unpatched tree
  # the patch can be re-applied (and checked) against, e.g. by
  # test/client-patch.test.mjs.
  git -C upstream/src checkout -- .
  echo "upstream: client patch applied"
fi
