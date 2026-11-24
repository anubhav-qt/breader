#!/bin/sh
# Keeps Azure asleep while the ThinkPad answers, and awake while it doesn't (ADR 0004).
# A timer runs it each minute (setup.sh). It asks the ThinkPad's /health; after MISSES misses in a
# row it also asks each of WAKE_URLS, every minute, until the ThinkPad answers again.
# Each ask says its misses in a row so far (x-breader-watch), which the server that hears it shows
# on the admin page's infra map (server/src/lib/seen.ts).
#
# Settings, in .env next to this file:
#   WAKE_URLS   the standby servers to keep awake, space separated (Azure's API and Suwayomi)
#   HOME_HEALTH the ThinkPad's health address (default https://api.breader.site/health)
set -u

here=$(cd "$(dirname "$0")" && pwd)
if [ -f "$here/.env" ]; then
  . "$here/.env"
fi

HOME_HEALTH=${HOME_HEALTH:-https://api.breader.site/health}
WAKE_URLS=${WAKE_URLS:-}
MISSES=10
STATE=${WATCH_STATE:-$HOME/.breader-watch}

before=0
if [ -f "$STATE" ]; then
  before=$(cat "$STATE")
fi

if curl -fs -o /dev/null --max-time 20 -H "x-breader-watch: $before" "$HOME_HEALTH"; then
  if [ "$before" -ge "$MISSES" ]; then
    echo "the ThinkPad is back after $before minutes; letting Azure sleep"
  fi
  echo 0 > "$STATE"
  exit 0
fi

now=$((before + 1))
echo "$now" > "$STATE"
if [ "$now" -lt "$MISSES" ]; then
  exit 0
fi
if [ "$now" -eq "$MISSES" ]; then
  echo "the ThinkPad missed $MISSES minutes in a row; keeping Azure awake"
fi

for url in $WAKE_URLS; do
  code=$(curl -s -o /dev/null --max-time 90 -w '%{http_code}' -H "x-breader-watch: $now" "$url")
  if [ "$code" = "000" ]; then
    echo "no answer from $url"
  fi
done
