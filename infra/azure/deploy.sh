#!/bin/sh
# Puts one Breader server on Azure Container Apps (ADR 0004), in one region, from its settings in
# infra/azure/.env.<name> (copy .env.example). Run it again to update that server: a new image, new
# settings. One region a run; Breader has one (the free plan allows one environment a subscription):
#   sh infra/azure/deploy.sh <name> <location>        e.g.  sh infra/azure/deploy.sh sg southeastasia
# Needs the Azure CLI, logged in (`az login`), with its containerapp extension.
#
# It sleeps when nobody asks it anything (no replica at all), so it costs nothing then, and wakes
# on the next request in a few seconds; two replicas at most. Its address then goes behind
# Cloudflare (README.md › Azure).
set -eu
set -f

NAME=${1:?give the server a name, as in .env.NAME}
LOCATION=${2:?an Azure location, such as southeastasia}
FILE="$(dirname "$0")/.env.$NAME"
if [ ! -f "$FILE" ]; then
  echo "no settings at $FILE: copy .env.example there first" >&2
  exit 1
fi

GROUP="breader-$NAME"
ENVIRONMENT="breader-$NAME"
APP="breader-api"
IMAGE=""

# Every setting is kept as a secret, and its variable reads the secret, so no value shows on the
# app's page. Secret names are the variables' own, in lower case with dashes.
secrets=""
vars=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '' | '#'*) continue ;;
  esac
  key=${line%%=*}
  value=${line#*=}
  if [ "$key" = IMAGE ]; then
    IMAGE=$value
    continue
  fi
  ref=$(echo "$key" | tr 'A-Z_' 'a-z-')
  secrets="$secrets $ref=$value"
  vars="$vars $key=secretref:$ref"
done < "$FILE"

if [ -z "$IMAGE" ]; then
  echo "set IMAGE in $FILE" >&2
  exit 1
fi

az group create --name "$GROUP" --location "$LOCATION" --output none

# No Log Analytics workspace: it would cost money. Logs go to Sentry as elsewhere.
if ! az containerapp env show --name "$ENVIRONMENT" --resource-group "$GROUP" --output none 2>/dev/null; then
  az containerapp env create --name "$ENVIRONMENT" --resource-group "$GROUP" --location "$LOCATION" \
    --logs-destination none --output none
fi

if az containerapp show --name "$APP" --resource-group "$GROUP" --output none 2>/dev/null; then
  # shellcheck disable=SC2086
  az containerapp secret set --name "$APP" --resource-group "$GROUP" --secrets $secrets --output none
  # shellcheck disable=SC2086
  az containerapp update --name "$APP" --resource-group "$GROUP" --image "$IMAGE" \
    --min-replicas 0 --max-replicas 2 --set-env-vars $vars --output none
else
  # shellcheck disable=SC2086
  az containerapp create --name "$APP" --resource-group "$GROUP" --environment "$ENVIRONMENT" \
    --image "$IMAGE" --target-port 8787 --ingress external \
    --cpu 0.5 --memory 1.0Gi --min-replicas 0 --max-replicas 2 \
    --secrets $secrets --env-vars $vars --output none
fi

echo "$APP in $LOCATION answers at https://$(az containerapp show --name "$APP" --resource-group "$GROUP" \
  --query properties.configuration.ingress.fqdn --output tsv)"
