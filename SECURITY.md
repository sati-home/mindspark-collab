# Security

This is a backend that verifies forge tokens and gates access to shared maps, so a flaw here can expose someone else's data. Please report vulnerabilities privately.

## Reporting

Use GitHub's private vulnerability reporting: [Report a vulnerability](https://github.com/sati-home/mindspark-collab/security/advisories/new). Do not open a public issue for anything that could be exploited.

Include the companion version (image tag or commit), the pinned MindSpark ref, the forge you tested against, and steps to reproduce. A proof of concept against your own instance is welcome; do not test against instances you do not own.

You will get an acknowledgement within a week. Fixes ship as a new tag on `main` and an image on GHCR, and the advisory is published once the fix is out.

## Scope

- Everything in `src/collab/`: the session endpoint, the shared-map API, the WebSocket relay, static serving, the limits.
- The Dockerfile and compose defaults.

Out of scope here, report upstream instead: the MindSpark client, `worker/auth-core.js` and `worker/collab-http.js` (this repo runs them unmodified from the pinned ref), and the forge you sign in to.

## What is already in place

The design and the 2026-09 review are summarised in `AGENTS.md`: zero runtime dependencies, secrets only via environment, body caps and a rate bucket on every route, an Origin gate on the WebSocket upgrade, a non-root read-only container. CI runs SAST, secret detection and Trivy scans on every push.
