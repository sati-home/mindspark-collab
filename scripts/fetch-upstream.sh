#!/bin/sh
# Pull the pinned MindSpark sources this companion runs against.
#   sh scripts/fetch-upstream.sh [ref]
# ref : tag, branch or commit (default: the one in .upstream-ref)
set -eu
cd "$(dirname "$0")/.."
REF="${1:-$(cat .upstream-ref)}"
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
