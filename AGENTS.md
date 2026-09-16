# Working on mindspark-collab

Conventions for contributors and coding agents. The tests enforce most of them; this file says why.

## What this is

A drop-in for the MindSpark upstream worker's client contract: same routes, same messages, same identity token. The contract is owned upstream (`README.md` → *Companion backend* in the MindSpark repo). When the contract and this code disagree, the contract wins; change it upstream first, then here.

## Rules

- **Zero runtime dependencies.** `package.json` has none and stays that way. Node ≥ 22 built-ins only: `node:http`, `node:sqlite`, `node:crypto`, `node:test`. A feature that needs a package needs a different design.
- **Upstream's modules run unmodified.** `upstream/auth-core.js` and `upstream/collab-http.js` are copied from the pinned MindSpark ref by `scripts/fetch-upstream.sh` and never edited. Authorization decisions come from `authorizeRequest()` there; do not reimplement or wrap them with extra policy. Upstream's own `auth-core` tests run against the copy.
- **One pin, read from `.upstream-ref`.** The Dockerfile and compose carry the same sha as a default. Moving the pin: change all three, `npm run fetch-upstream`, `npm test`.
- **The bundled client is upstream, unmodified.** There is no client patch. `test/upstream-pin.test.mjs` pins what the client must carry (discovery, forge identity, socket identity); a feature the companion needs from the client is proposed upstream first and lands here as a re-pin. Never reintroduce a patch step in the Dockerfile or the fetch script.
- **No forge branches.** GitLab, Gitea/Forgejo and GitHub differ only in the forge descriptor in `src/collab/session.js`. An `if (forge === 'gitlab')` anywhere else is a bug.
- **Tests first, `node:test` only.** Every behaviour change starts with a failing test in `test/`. Prefer real code over mocks: the suite boots the real server on a free port and talks HTTP and WebSocket to it. `npm test` and `npm run e2e` must both pass before a commit.
- **Secrets only via environment.** `AUTH_SECRET` is required and never defaulted, logged or written. Room ids are capabilities: log route classes, not URLs.
- **Errors that lose work are never swallowed.** A `catch {}` is fine for best-effort cleanup only; anything a user would notice logs a warning.
- **Security posture is part of the change.** New routes get a body cap and go through the rate bucket; new socket messages decide whether they are a write (`snapshot`, `op`) or not (`cur`, `name`, `ping`). The Dockerfile stays non-root, read-only, npm-free; the CI scans (SAST, secret detection, Trivy fs and image) stay red on HIGH.

## Layout

| Path | What |
|---|---|
| `src/collab/server.js` | entry point, configuration from env |
| `src/collab/app.js` | HTTP routes, static serving, WebSocket upgrade gate |
| `src/collab/session.js` | forge token → signed identity |
| `src/collab/rooms.js`, `ws.js`, `limits.js`, `storage.js` | relay, frames, limits, SQLite |
| `upstream/` | gitignored; the pinned MindSpark checkout and the two copied modules |
| `docker/` | image, compose |
| `test/` | the suite; `test/upstream/` holds upstream's copied tests |

## Commits and pull requests

- Plain commit subjects that say what changed and why; no ticket prefixes, no emoji.
- No links to AI chat sessions in commits, PRs or docs.
- Changes to the client contract are made upstream in MindSpark first, as a PR from the fork, and land here as a re-pin.
