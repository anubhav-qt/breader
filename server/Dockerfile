# One image, four commands (build context: the repository root):
#   node dist/api.js         the API (default), as ROLE=laptop or ROLE=fallback
#   node dist/worker.js      the laptop's feed, file copy and backups
#   node dist/migrate.js     schema migrations for Supabase and the copy
#   node ai/dist/marker.js   voice marks and Revisit notes for books with AI on (ai/tools/marker.ts)
# The bundles are plain JavaScript, so they are built once on the CI machine's own platform.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
COPY shared/package.json shared/
COPY server/package.json server/
# The frontend's packages too: the marker reads books with the app's own parsers.
RUN npm ci --workspace server --workspace shared --workspace frontend --ignore-scripts --no-audit --no-fund
COPY ai/package.json ai/package-lock.json ai/
RUN npm ci --prefix ai --omit=dev --ignore-scripts --no-audit --no-fund
COPY shared shared
COPY server server
RUN npm run build -w server
COPY frontend/src/books frontend/src/books
COPY frontend/src/lib/format.ts frontend/src/lib/
COPY frontend/src/features/reader/dom.ts frontend/src/features/reader/search.ts frontend/src/features/reader/
COPY ai/build.mjs ai/
COPY ai/tools ai/tools
RUN node ai/build.mjs

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
# The marker, which the worker runs: its bundle, the procedure its prompts quote, the sealed NVIDIA
# key (ai/tools/seal.ts), and the two packages that load files of their own (ai/build.mjs): jsdom
# whole, and only the build of pdf.js it uses.
COPY --from=build /app/ai/dist ./ai/dist
COPY ai/procedure.md ai/nvidia-key.enc ./ai/
COPY --from=build /app/ai/node_modules ./ai/node_modules
COPY --from=build /app/node_modules/pdfjs-dist/package.json ./node_modules/pdfjs-dist/
COPY --from=build /app/node_modules/pdfjs-dist/legacy/build/pdf.mjs /app/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs ./node_modules/pdfjs-dist/legacy/build/
USER node
EXPOSE 8787
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/api.js"]
