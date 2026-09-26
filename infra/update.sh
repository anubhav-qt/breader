#!/bin/sh
# Keeps the laptop on the latest server image. launchd runs it every 5 minutes:
#   infra/update.sh --install     start checking (writes a LaunchAgent for this user)
#   infra/update.sh --uninstall   stop checking
#   infra/update.sh               check once now
# It pulls the image and restarts the stack only when the running API is on an older one, so a
# stack you stopped yourself stays stopped. Migrations run first (the migrate service); if they
# fail, the old version keeps running and the next check tries again.
set -eu
cd "$(dirname "$0")"
DIR=$(pwd)
LABEL=example.breader.update
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "${1:-}" in
  --install)
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$DIR/update.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.docker/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key><string>$DIR/update.log</string>
  <key>StandardErrorPath</key><string>$DIR/update.log</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Checking for new images every 5 minutes. Log: $DIR/update.log"
    exit 0 ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Stopped checking for new images."
    exit 0 ;;
esac

compose() { docker compose -f compose.yml "$@"; }
docker info >/dev/null 2>&1 || exit 0 # Docker Desktop isn't running yet
IMAGE=$(sed -n 's/^IMAGE=//p' .env)

compose pull --quiet api
want=$(docker image inspect --format '{{.Id}}' "$IMAGE")
running=$(compose ps --quiet api) # running only
have=$(test -n "$running" && docker inspect --format '{{.Image}}' "$running" || true)

if [ -n "$running" ] && [ "$want" != "$have" ]; then
  echo "$(date '+%F %T') updating to $want"
  compose pull --quiet
  compose up -d --remove-orphans
  docker image prune -f >/dev/null
fi
