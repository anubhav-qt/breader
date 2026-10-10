# One image, four commands (build context: the repository root):
#   node dist/api.js         the API (default), as ROLE=laptop or ROLE=fallback
#   node dist/worker.js      the laptop's feed, file copy and backups
#   node dist/migrate.js     schema migrations for Supabase and the copy
#   node ai/dist/marker.js   voice marks, music and Revisit notes for books with AI on (ai/tools/marker.ts)
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
COPY ai/pi ai/pi
COPY ai/tools ai/tools
RUN node ai/build.mjs

# The cover encoder (manga/covers.ts) is native code: the build for the image's own platform,
# fetched on the CI machine's, at the version the lockfile has.
FROM --platform=$BUILDPLATFORM node:24-alpine AS sharp
ARG TARGETARCH
WORKDIR /sharp
COPY package-lock.json /tmp/
RUN cpu=$TARGETARCH && if [ "$cpu" = amd64 ]; then cpu=x64; fi \
  && v=$(node -p "require('/tmp/package-lock.json').packages['node_modules/sharp'].version") \
  && npm install --no-package-lock --no-audit --no-fund --ignore-scripts --os=linux --libc=musl --cpu=$cpu "sharp@$v"

# The AI accounts' proxy, CLIProxyAPI (server/src/jobs/cliproxy.ts): its static build, for the
# image's platform, checked against the checksums its release lists.
FROM --platform=$BUILDPLATFORM node:24-alpine AS cliproxy
ARG TARGETARCH
ARG CLIPROXY=8.0.5
WORKDIR /cliproxy
RUN arch=amd64 && sum=1424923a52a62e3db3b6871e5f97b046da6d000ba071b1c2fe28013668d7b54b \
  && if [ "$TARGETARCH" = arm64 ]; then arch=aarch64 && sum=3b255caee58136dff328be9a1e307f4d887b1bce5da5549951e7d8ebf3017ce2; fi \
  && file="CLIProxyAPI_${CLIPROXY}_linux_${arch}_no-plugin.tar.gz" \
  && wget -q "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXY}/$file" \
  && echo "$sum  $file" | sha256sum -c - \
  && tar -xzf "$file" cli-proxy-api

FROM node:24-alpine
# pg_dump for backups (must be at least the copy's major version), tini to forward signals.
# ffmpeg and yt-dlp for the marker's music (ai/tools/youtube.ts, sound.ts): yt-dlp in a Python
# venv the worker can write to, since it keeps it current every day (jobs/ytdlp.ts).
RUN apk add --no-cache postgresql17-client tini tzdata ffmpeg python3 \
  && python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]" \
  && mkdir -p /data/files /data/backups /data/voices /data/manga && chown -R node:node /data /opt/yt-dlp
ENV YT_DLP=/opt/yt-dlp/bin/yt-dlp
COPY --from=cliproxy /cliproxy/cli-proxy-api /usr/local/bin/cli-proxy-api
WORKDIR /app
ENV NODE_ENV=production
# The commit, shown by /health, so you can see which version each server runs.
ARG RELEASE=dev
ENV RELEASE=$RELEASE
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/drizzle ./drizzle
# The server voice's MP3 encoder sits beside the bundle rather than in it (build.mjs), and the
# cover encoder too, built for this platform.
COPY --from=build /app/node_modules/@breezystack/lamejs ./node_modules/@breezystack/lamejs
COPY --from=sharp /sharp/node_modules ./node_modules
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
