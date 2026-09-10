# syntax=docker/dockerfile:1
# Stage 1: the pinned MindSpark sources (app + the two pure worker modules).
FROM alpine/git:latest AS upstream
ARG MINDSPARK_REF=4e81dc6
ARG CLIENT_PATCH=1
WORKDIR /src
RUN git clone https://github.com/prasadpatil25/MindSpark.git . && git checkout "$MINDSPARK_REF"
COPY docker/client-collab.patch /tmp/client-collab.patch
RUN if [ "$CLIENT_PATCH" = "1" ]; then git apply /tmp/client-collab.patch; fi

# Stage 2: the companion.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js app.js session.js rooms.js storage.js ws.js ./
COPY --from=upstream /src/public ./upstream/public
COPY --from=upstream /src/worker/auth-core.js /src/worker/collab-http.js ./upstream/
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
