# mindspark-collab

A self-hostable collaboration backend for [MindSpark](https://github.com/prasadpatil25/MindSpark): shared maps with access control, live sessions and verified identity from your own GitLab, Gitea/Forgejo or GitHub - as one container, zero runtime dependencies, while every map stays a plain JSON file in git.

It implements the existing MindSpark client contract as a drop-in for the upstream Cloudflare worker, so an unmodified MindSpark build only needs to be pointed at it.

## Run

```sh
cp docker/.env.example docker/.env      # set AUTH_SECRET, ALLOWED_INSTANCES, COLLAB_HOST
docker compose -f docker/compose.yml up -d --build
```

`podman build -f docker/Dockerfile -t mindspark-collab .` and `podman run` work the same way against the same Dockerfile, if you'd rather not run Docker.

Without Docker: `npm run fetch-upstream -- 4e81dc6 --patch`, then `AUTH_SECRET=… ALLOWED_INSTANCES=https://gitlab.example npm start`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `DATA_DIR` | `./data` | SQLite location (`collab.db`) |
| `AUTH_SECRET` | *(required)* | HMAC secret for identity tokens |
| `ALLOWED_INSTANCES` | *(empty)* | self-hosted forge origins the session endpoint may contact |
| `ALLOWED_ORIGIN` | *(unset)* | CORS origin when the app is hosted elsewhere |
| `PUBLIC_DIR` | bundled app | serve a different MindSpark build |

Tests: `npm test` (unit, plus upstream's own `auth-core` tests against the copied module) and `npm run e2e`.

## Status

Runs the upstream client contract end to end. The bundled app carries a small patch (`docker/client-collab.patch`) that decouples collaboration from GitHub OAuth and reads `/healthz`; that patch is the proposed upstream change.

MIT.
