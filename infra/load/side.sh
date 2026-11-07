#!/bin/sh
# Starts a side copy of the API next to the Docker test stack (compose project breader-manga), on
# port 8797, for the load test. Test stack only, never production.
#
#   ENV_FILE=~/somewhere/api.env infra/load/side.sh
#
# ENV_FILE: the stack API's env (docker inspect breader-manga-api-1), with CLIENT_IP_HEADER set to
#   x-forwarded-for, so each fake reader has an address of its own. Keep it out of the repo.
# DIST: a built server/dist/api.js to run instead of the image's (npm run build -w server).
# COPIES: how many copies of the API share the port (cluster.mjs). 1 when unset.
# Extra arguments go to docker create.
set -e
here=$(cd "$(dirname "$0")" && pwd)
: "${ENV_FILE:?set ENV_FILE to the env file of the side copy}"
copies=${COPIES:-1}

set -- --env-file "$ENV_FILE" -e COPIES="$copies" -e MANGA_KEEP=false "$@"
if [ -n "$DIST" ]; then
  set -- -v "$DIST:/app/dist/api.js:ro" "$@"
fi

docker rm -f breader-load-api >/dev/null 2>&1 || true
docker create --name breader-load-api "$@" \
  --network breader-manga_default -p 8797:8787 \
  -v "$here/cluster.mjs:/app/cluster.mjs:ro" \
  -v breader-manga_manga:/data/manga -v breader-manga_voices:/data/voices -v breader-manga_books:/data/books \
  breader-server:manga node /app/cluster.mjs >/dev/null
docker network connect breader-manga_novels breader-load-api
docker start breader-load-api >/dev/null

for i in $(seq 1 30); do
  if curl -sf -m 2 localhost:8797/health >/dev/null; then
    break
  fi
  sleep 1
done
# Let the AniList warm-up settle before the test starts.
sleep 15
