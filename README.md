# mindspark-collab

![status](https://img.shields.io/badge/license-MIT-green) ![deps](https://img.shields.io/badge/dependencies-0-blue) ![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)

A self-hostable collaboration backend for [MindSpark](https://github.com/prasadpatil25/MindSpark): shared maps with access control, live sessions and verified identity from your own GitLab, Gitea/Forgejo or GitHub - as one container, zero runtime dependencies, while every map stays a plain JSON file in git.

It implements the existing MindSpark client contract as a drop-in for the upstream Cloudflare worker: same routes, same messages, same identity token. Upstream's pure modules (`auth-core.js`, `collab-http.js`) run unmodified, pulled from a pinned MindSpark release at build time.

## How it works

```
browser ──▶ mindspark-collab (one Node process)
              ├─ serves the MindSpark app
              ├─ /api/session       your forge token ──▶ forge user API ──▶ signed identity
              ├─ /api/collab/<room> shared-map snapshots + access control (SQLite)
              └─ /api/collab/<room> WebSocket relay for live sessions
browser ──▶ your forge: map JSON commits with your own token, exactly as without the companion
```

- **Maps stay in git.** The companion holds room state only - snapshots, access lists, presence. It never sees a repository token.
- **Identity comes from your forge.** A user's forge token is verified once against `ALLOWED_INSTANCES` and turned into a 12-hour signed identity (`gitlab:<host>:<id>` and so on), which drives named collaborators, roles and revoke.
- **Live sessions are relayed, not stored.** A room that has an access list is gated on the WebSocket too: the app sends its identity on the upgrade, joining needs read access, storing a snapshot or relaying an edit needs write access. A room without an access list (a live session of an unpublished map) is open to anyone who has its id, as with the upstream worker; set `REQUIRE_IDENTITY=1` to close that as well.
- **Limits.** Request bodies are capped (2 MiB on the collab API), sign-in and writes are rate limited per client, sockets are capped in total and per room, and silent sockets are reaped.

## Run

The image is published to GitHub Container Registry as `ghcr.io/sati-home/mindspark-collab` - `latest` and `<version>` from each release tag, `main` and `sha-<short>` from every commit on main. Each image carries the MindSpark ref it bundles as the label `io.mindspark.upstream-ref`.

With Docker Compose (the file carries a traefik example - edit or drop the `labels`/`networks` and add a `ports:` mapping if you don't run traefik):

```sh
cp docker/.env.example docker/.env      # AUTH_SECRET, ALLOWED_INSTANCES, COLLAB_HOST
docker compose -f docker/compose.yml up -d            # pulls the published image
docker compose -f docker/compose.yml up -d --build    # or build it here
```

With Podman, or plain Docker without compose:

```sh
podman run -d -p 3000:3000 --env-file docker/.env -v collab-data:/app/data ghcr.io/sati-home/mindspark-collab:latest
# or build locally:
podman build -f docker/Dockerfile -t mindspark-collab .
```

The image carries a `HEALTHCHECK` on `/healthz`; Podman keeps it only when building with `--format docker` (OCI images have no such field).

Without a container: `npm run fetch-upstream -- $(cat .upstream-ref) --patch`, then `AUTH_SECRET=… ALLOWED_INSTANCES=https://gitlab.example.com npm start`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `DATA_DIR` | `./data` | SQLite location (`collab.db`) |
| `AUTH_SECRET` | *(required)* | HMAC secret for identity tokens (`openssl rand -hex 32`); the server refuses to start without it |
| `ALLOWED_INSTANCES` | *(empty)* | comma-separated origins of self-hosted forges the session endpoint may contact, e.g. `https://gitlab.example.com,https://codeberg.org` |
| `ALLOWED_ORIGIN` | *(unset)* | CORS origin, only when the app is hosted on another origin |
| `PUBLIC_DIR` | bundled app | serve a different MindSpark build |
| `TRUST_PROXY` | unset | set to `1` behind a reverse proxy so rate limits key on the forwarded client address, not the proxy's |
| `REQUIRE_IDENTITY` | unset | set to `1` to refuse anonymous room writes and live-session joins entirely (no anonymous room creation; legacy anonymous links stop working) |
| `RATE_PER_MIN` | `60` | per-client budget for sign-in, room writes and socket upgrades (burst of 30) |
| `MAX_SOCKETS`, `MAX_SOCKETS_PER_ROOM` | `500`, `32` | live-session socket caps |
| `IDLE_TIMEOUT_MS` | `60000` | a socket silent for longer is closed (the app pings every 6 s) |

`ALLOWED_INSTANCES` is also injected into the served app's Content-Security-Policy, so the browser may talk to those forges.

## Sign-in on your forge

Users sign in from the app's login screen exactly as documented upstream: an access token, or OAuth with a public (non-confidential) application registered once on the instance:

- **GitLab:** Preferences → Applications → Add new application, scope `api`, *Confidential* unchecked, redirect URI `https://<your-companion-host>/oauth-callback.html`.
- **Gitea / Forgejo:** Settings → Applications → Create a new OAuth2 application, *Confidential Client* unchecked, same redirect URI; the instance needs `[cors] ENABLED = true`.
- **GitHub:** a fine-grained token. The GitHub OAuth exchange needs a client secret and stays with the upstream worker.

## The bundled app and the upstream pin

`.upstream-ref` names the MindSpark commit or tag the container is built from. Since MindSpark #50 the client discovers this backend by itself (`/healthz` answering `{"mode":"collab"}`), so an unmodified build already offers live sessions and shared maps here. The bundled app is byte-identical to the pinned release except for one small client patch, `docker/client-collab.patch`, which carries what is still pending upstream: the identity on the WebSocket upgrade, so rooms with an access list can gate live sessions the way the HTTP API does (the identity request naming the forge and the collaborator lookup on the signed-in forge landed as MindSpark #52). Once that lands, the patch goes away. To move to a newer MindSpark: change `.upstream-ref`, run `npm run fetch-upstream -- <ref> --patch`, run the tests (they check the patch still applies), rebuild.

## Development

The server lives in `src/collab/` (`server.js` is the entry point, everything else is what it imports); `docker/` holds the image and the client patch, `test/` the suite, `scripts/` the upstream fetch.

- `npm run fetch-upstream` - clone the pinned MindSpark into `upstream/` (gitignored).
- `npm test` - unit tests, plus upstream's own `auth-core` tests against the copied module.
- `npm run e2e` - starts the server on a free port, two live clients, one HTTP snapshot round-trip.
- `.gitlab-ci.yml` - tests, GitLab SAST and secret detection, Trivy filesystem and image scans.
- `.github/workflows/ci.yml` - the same tests on Node 22 and 24, the image build and boot check, and the publish to GHCR.
- `AGENTS.md` - the conventions the tests enforce, for contributors and coding agents.

## Not (yet) here

The GitHub OAuth code exchange and the GPT map-import endpoint of the upstream worker. Access rules derived from forge project membership ("everyone who can write the project may edit") are a natural next step for single-forge teams.

## License

MIT - do anything you want with it. No restrictions.
