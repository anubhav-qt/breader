#!/usr/bin/env bash
# Ships dev to production from this machine: what GitHub's CI did, run here instead.
#
#   infra/ship.sh            every step, in order
#   infra/ship.sh app        only the steps named (check always runs first)
#
# Steps: check, test, push, model, image, migrate, deploy, app, live.
# Settings come from infra/.env.ship (copy infra/.env.ship.example). The laptop picks the new
# image up by itself within 5 minutes (infra/update.sh); other servers are told by their deploy
# hooks (DEPLOY_HOOKS); `live` waits until every server in VITE_API_SERVERS is on it.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=ghcr.io/anubhav-qt/breader-server
PROJECT=breader
# Breader's Cloudflare account, as a login can see more than one.
export CLOUDFLARE_ACCOUNT_ID=84647e95d51947e4149cbfc398afc4e1
SETTINGS=infra/.env.ship
SHA=$(git rev-parse HEAD)
STEPS=(check test push model image migrate deploy app live)

say() {
  printf '\n== %s\n' "$*"
}

fail() {
  printf '\nship: %s\n' "$*" >&2
  exit 1
}

sha256() {
  shasum -a 256 "$1" | cut -d' ' -f1
}

# Is this machine ready, and is dev what it says it is?
step_check() {
  say "check"
  if [ "$(git branch --show-current)" != dev ]; then
    fail "ship from dev, not $(git branch --show-current)"
  fi
  if [ -n "$(git status --porcelain)" ]; then
    fail "commit or put away your changes first"
  fi
  git fetch -q origin dev
  if ! git merge-base --is-ancestor origin/dev HEAD; then
    fail "origin/dev has commits you don't: pull first"
  fi

  local node
  node=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$node" != "$(cat server/.nvmrc)" ]; then
    fail "use Node $(cat server/.nvmrc) (nvm use $(cat server/.nvmrc)); this is Node $node"
  fi
  if ! docker info > /dev/null 2>&1; then
    fail "start Docker first"
  fi

  if [ ! -f "$SETTINGS" ]; then
    fail "copy infra/.env.ship.example to $SETTINGS and fill it in"
  fi
  set -a
  # shellcheck source=/dev/null
  . "$SETTINGS"
  set +a
  # The older names, from before any number of servers.
  PRIMARY_MIGRATE_URL=${PRIMARY_MIGRATE_URL:-${SUPABASE_SESSION_URL:-}}
  DEPLOY_HOOKS=${DEPLOY_HOOKS:-${RENDER_DEPLOY_HOOK:-}}
  if [ -z "${VITE_API_SERVERS:-}" ] && [ -n "${VITE_API_URL:-}" ]; then
    VITE_API_SERVERS="$VITE_API_URL${VITE_API_FALLBACK_URL:+,$VITE_API_FALLBACK_URL}"
  fi
  export VITE_API_SERVERS
  local name
  for name in PRIMARY_MIGRATE_URL VITE_API_SERVERS VITE_SENTRY_DSN; do
    if [ -z "${!name:-}" ]; then
      fail "$name is empty in $SETTINGS"
    fi
  done

  if ! gh auth status > /dev/null 2>&1; then
    fail "sign in to GitHub: gh auth login"
  fi
  if ! npx --yes wrangler@4 whoami 2>/dev/null | grep -q 'associated with'; then
    fail "sign in to Cloudflare: npx wrangler@4 login"
  fi
}

# Type checks, lint and every test, against the same stand-ins as local development.
step_test() {
  say "test"
  if standInsUp; then
    # The restore test runs pg_dump inside the copy's container (server/test/ops.test.ts).
    MIRROR_CONTAINER=$(docker ps --filter publish=54333 --format '{{.Names}}')
    export MIRROR_CONTAINER
    echo "the stand-ins are up already, the copy in $MIRROR_CONTAINER"
  else
    docker compose -f infra/compose.dev.yml up -d --wait primary mirror s3
  fi
  until curl -s -o /dev/null http://localhost:9000; do
    sleep 1
  done
  npm ci
  npm run typecheck
  npm run lint -w frontend
  npm test
}

# Postgres, its copy and S3 answering on the ports the tests use (server/test/env.ts), from this
# stack or another checkout's.
standInsUp() {
  local port
  for port in 54322 54333 9000; do
    if ! (exec 3<> "/dev/tcp/localhost/$port") 2> /dev/null; then
      return 1
    fi
  done
}

step_push() {
  say "push"
  git push origin dev
}

# Each round of the panel model goes out once as a release, which the app build fetches. It isn't
# in git (Git LFS's budget is spent): live.json names it by its hash, and a machine that didn't make
# it fetches it from its release, for the server image.
step_model() {
  say "model"
  local file=ai/panels/model/live.onnx
  local want
  want=$(node -p "require('./ai/panels/model/live.json').sha256")
  local tag="panels-${want:0:12}"
  if [ ! -f "$file" ] || [ "$(head -c 7 "$file")" = version ] || [ "$(sha256 "$file")" != "$want" ]; then
    gh release download "$tag" -R anubhav-qt/breader -p live.onnx -O "$file" --clobber \
      || fail "$file isn't here, nor in the release $tag: make it with npm --prefix ai run panels-live -- N"
  fi
  [ "$(sha256 "$file")" = "$want" ] || fail "$file isn't the model live.json names"
  if gh release view "$tag" > /dev/null 2>&1; then
    echo "$tag is out already"
    return
  fi
  local round
  round=$(node -p "require('./ai/panels/model/live.json').round")
  gh release create "$tag" "$file" --target "$SHA" --latest=false \
    --title "Panel model, round $round" \
    --notes "Round $round of the manga panel model (ai/panels), for the app to run on readers' devices. SHA-256 $(sha256 "$file")."
}

# The server image: amd64 for the laptop and Render, arm64 for Macs.
step_image() {
  say "image"
  docker buildx build --platform linux/amd64,linux/arm64 \
    --build-arg "RELEASE=$SHA" \
    -f server/Dockerfile \
    -t "$IMAGE:latest" -t "$IMAGE:$SHA" \
    --push .
}

# Migrations only ever add, so the running servers keep working while this runs.
step_migrate() {
  say "migrate"
  docker run --rm -e PRIMARY_URL="$PRIMARY_MIGRATE_URL" -e PRIMARY_SSL="${PRIMARY_MIGRATE_SSL:-require}" \
    "$IMAGE:$SHA" node dist/migrate.js
}

# Servers that pull :latest when told to, which now points at this commit. Each migrates its own
# read copy as it starts (server/src/mirror/copy.ts).
step_deploy() {
  say "deploy"
  local hook
  local hooks=()
  local told=0
  IFS=',' read -ra hooks <<< "${DEPLOY_HOOKS:-}"
  # macOS's bash counts an empty array as unset.
  if [ ${#hooks[@]} -eq 0 ]; then
    echo "no deploy hooks"
    return
  fi
  for hook in "${hooks[@]}"; do
    hook=$(echo "$hook" | xargs)
    if [ -z "$hook" ]; then
      continue
    fi
    curl -fsS -X POST "$hook" > /dev/null
    told=$((told + 1))
  done
  echo "told $told server(s) to deploy"
}

# The app, built here as Pages would build it, then uploaded.
step_app() {
  say "app"
  CF_PAGES=1 CF_PAGES_COMMIT_SHA="$SHA" npm run build -w frontend
  npx --yes wrangler@4 pages deploy frontend/dist \
    --project-name "$PROJECT" --branch dev \
    --commit-hash "$SHA" --commit-message "$(git log -1 --format=%s)" --commit-dirty=false
}

# Waits until every server reports this commit and breader.site serves this build.
step_live() {
  say "live"
  local server
  local servers
  IFS=',' read -ra servers <<< "$VITE_API_SERVERS"
  for server in "${servers[@]}"; do
    server=$(echo "$server" | xargs)
    server=${server%/}
    if [ -z "$server" ]; then
      continue
    fi
    waitFor "$server" "curl -fsS $server/health | grep -q $SHA"
  done
  local page
  page=$(grep -o 'assets/main-[^"]*\.js' frontend/dist/index.html)
  waitFor https://breader.site "curl -fsS https://breader.site/ | grep -q $page"
  echo "all live on ${SHA:0:7}"
}

# Tries `$2` every 10 seconds for up to 15 minutes.
waitFor() {
  local tries=0
  until eval "$2" > /dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 90 ]; then
      fail "$1 isn't on ${SHA:0:7} after 15 minutes"
    fi
    sleep 10
  done
  echo "$1 is on ${SHA:0:7}"
}

main() {
  local wanted=("$@")
  if [ ${#wanted[@]} -eq 0 ]; then
    wanted=("${STEPS[@]}")
  fi
  local step
  for step in "${wanted[@]}"; do
    if [[ ! " ${STEPS[*]} " =~ " $step " ]]; then
      fail "no step called $step (steps: ${STEPS[*]})"
    fi
  done
  step_check
  for step in "${wanted[@]}"; do
    if [ "$step" != check ]; then
      "step_$step"
    fi
  done
}

main "$@"
