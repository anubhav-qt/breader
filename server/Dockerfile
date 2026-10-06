# One image, three commands (build context: the repository root):
#   node dist/api.js      the API (default), as ROLE=laptop or ROLE=fallback
#   node dist/worker.js   the laptop's feed, file copy and backups
#   node dist/migrate.js  schema migrations for Supabase and the copy
# The bundle is plain JavaScript, so it is built once on the CI machine's own platform.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
COPY shared/package.json shared/
COPY server/package.json server/
RUN npm ci --workspace server --workspace shared --ignore-scripts --no-audit --no-fund
COPY shared shared
COPY server server
RUN npm run build -w server

FROM node:24-alpine
# pg_dump for backups (must be at least the copy's major version), tini to forward signals.
RUN apk add --no-cache postgresql17-client tini tzdata \
  && mkdir -p /data/files /data/backups /data/voices /data/manga && chown -R node:node /data
WORKDIR /app
ENV NODE_ENV=production
# The commit, shown by /health, so you can see which version each server runs.
ARG RELEASE=dev
ENV RELEASE=$RELEASE
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/drizzle ./drizzle
# The server voice's MP3 encoder sits beside the bundle rather than in it (build.mjs).
COPY --from=build /app/node_modules/@breezystack/lamejs ./node_modules/@breezystack/lamejs
USER node
EXPOSE 8787
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/api.js"]
