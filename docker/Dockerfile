# syntax=docker/dockerfile:1
# Stage 1: the pinned MindSpark sources (app + the two pure worker modules).
FROM alpine/git:latest@sha256:6f3b5029566da8e90b24945933dcd806be866b64b1e706f51828bf84faccf21b AS upstream
ARG MINDSPARK_REF=06d2fed0ee93d4f93c409084b8da242294274434
ARG CLIENT_PATCH=1
WORKDIR /src
RUN git clone https://github.com/prasadpatil25/MindSpark.git . && git checkout "$MINDSPARK_REF"
COPY docker/client-collab.patch /tmp/client-collab.patch
RUN if [ "$CLIENT_PATCH" = "1" ]; then git apply /tmp/client-collab.patch; fi

# Stage 2: the companion.
FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
COPY package.json server.js app.js session.js rooms.js storage.js ws.js limits.js ./
COPY --from=upstream /src/public ./upstream/public
COPY --from=upstream /src/worker/auth-core.js /src/worker/collab-http.js ./upstream/
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
# Zero runtime dependencies: nothing here ever runs npm, so drop it (and its
# bundled packages, which are what image scanners flag in node:*-alpine), and
# pick up Alpine's security updates published since the base image was built.
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]
EXPOSE 3000
# Liveness for compose/orchestrators: the same /healthz the client probes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
