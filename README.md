# mindspark-collab

![status](https://img.shields.io/badge/license-MIT-green) ![deps](https://img.shields.io/badge/dependencies-0-blue) ![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)


A self-hostable collaboration backend for [MindSpark](https://github.com/prasadpatil25/MindSpark): shared maps with access control, live sessions and verified identity from your own GitLab, Gitea/Forgejo or GitHub - as one container, zero runtime dependencies, while every map stays a plain JSON file in git.

It implements the existing MindSpark client contract as a drop-in for the upstream Cloudflare worker, so an unmodified MindSpark build only needs to be pointed at it.

**Status:** design stage. See [`docs/planning/2026-09-10-mindspark-collab-design.md`](docs/planning/2026-09-10-mindspark-collab-design.md).

MIT.
