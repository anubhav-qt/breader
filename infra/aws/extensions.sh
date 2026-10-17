#!/bin/sh
# Installs the extensions Breader reads from (README.md › Manga sources: Suwayomi) when one is
# missing, and updates each installed one that has a newer version, as the laptop's worker does
# there. A timer runs it once a day (setup.sh); run it by hand after the first start.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
. "$here/.env"

WANTED="eu.kanade.tachiyomi.extension.all.mangafire
eu.kanade.tachiyomi.extension.en.weebcentral
eu.kanade.tachiyomi.extension.en.asurascans"

LIST='mutation { fetchExtensions(input: {}) { extensions { pkgName name isInstalled hasUpdate } } }'

# Sends Suwayomi one GraphQL request, its body as JSON, and says what it answered.
ask() {
  curl -fsS --max-time 300 -u "breader:$SUWAYOMI_PASSWORD" \
    -H 'content-type: application/json' --data "$1" http://127.0.0.1:4567/api/graphql
}

# Installs or updates (the patch, $2) one extension by its package name ($1).
change() {
  query="mutation(\$id: String!) { updateExtension(input: { id: \$id, patch: { $2: true } }) { extension { name versionName } } }"
  body=$(jq -nc --arg q "$query" --arg id "$1" '{query: $q, variables: {id: $id}}')
  answer=$(ask "$body")
  error=$(echo "$answer" | jq -r '.errors[0].message // empty')
  if [ -n "$error" ]; then
    echo "$1 couldn't $2: $error"
    return
  fi
  echo "$answer" | jq -r --arg what "$2" '"\($what): \(.data.updateExtension.extension.name) \(.data.updateExtension.extension.versionName)"'
}

list=$(ask "$(jq -nc --arg q "$LIST" '{query: $q}')")

for pkg in $WANTED; do
  installed=$(echo "$list" | jq -r --arg p "$pkg" '.data.fetchExtensions.extensions[] | select(.pkgName == $p) | .isInstalled')
  if [ "$installed" = "false" ]; then
    change "$pkg" install
  fi
done

due=$(echo "$list" | jq -r '.data.fetchExtensions.extensions[] | select(.isInstalled and .hasUpdate) | .pkgName')
for pkg in $due; do
  change "$pkg" update
done
echo "extensions checked"
