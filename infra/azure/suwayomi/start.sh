#!/bin/sh
# Suwayomi for the fallback on Azure Container Apps (README.md › Suwayomi on Azure). It keeps nothing
# between wakes, so each start it waits until Suwayomi answers and puts in the extensions Breader
# reads from (infra/aws/extensions.sh). Suwayomi keeps running if that fails.
# The app's start command fetches this file from GitHub (infra/azure/suwayomi.sh).

EXTENSIONS=${EXTENSIONS_SH:-https://raw.githubusercontent.com/anubhav-qt/breader/dev/infra/aws/extensions.sh}

/home/suwayomi/startup_script.sh &
server=$!

PING='{"query":"{ aboutServer { version } }"}'
tries=0
until curl -fs -o /dev/null --max-time 5 -u "breader:$AUTH_PASSWORD" \
  -H 'content-type: application/json' --data "$PING" http://127.0.0.1:4567/api/graphql; do
  tries=$((tries + 1))
  if [ "$tries" -ge 90 ]; then
    echo "Suwayomi didn't answer in 3 minutes; no extensions put in"
    break
  fi
  sleep 2
done

if [ "$tries" -lt 90 ]; then
  script=/tmp/extensions.sh
  if [ -f "$EXTENSIONS" ]; then
    cp "$EXTENSIONS" "$script"
  else
    curl -fsSL --max-time 60 "$EXTENSIONS" -o "$script"
  fi
  # Suwayomi's list of extensions fills in a little after it first answers, so a few tries.
  for attempt in 1 2 3 4 5 6; do
    if SUWAYOMI_PASSWORD="$AUTH_PASSWORD" sh "$script"; then
      break
    fi
    if [ "$attempt" = 6 ]; then
      echo "putting in the extensions failed"
    fi
    sleep 10
  done
fi

wait "$server"
