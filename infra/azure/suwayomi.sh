#!/bin/sh
# Puts Suwayomi for the fallback on Azure Container Apps, in the environment deploy.sh made
# (README.md › Suwayomi on Azure). Run it again to update it. It sleeps (no replica) until asked:
# the AWS machine's watch.sh keeps it awake while the ThinkPad is away, and Render asks it then.
#   sh infra/azure/suwayomi.sh <name> [branch]       e.g.  sh infra/azure/suwayomi.sh sg
# Its password is SUWAYOMI_PASSWORD in infra/azure/.env.<name>, letters and digits only
# (openssl rand -hex 24). Needs the Azure CLI, logged in, and jq.
set -eu

NAME=${1:?the server name, as in .env.NAME}
BRANCH=${2:-dev}
FILE="$(dirname "$0")/.env.$NAME"
GROUP="breader-$NAME"
ENVIRONMENT="breader-$NAME"
APP="breader-sw"
IMAGE="ghcr.io/suwayomi/suwayomi-server:v2.4.2366"
RAW="https://raw.githubusercontent.com/anubhav-qt/breader/$BRANCH/infra"

PASSWORD=$(grep '^SUWAYOMI_PASSWORD=' "$FILE" | cut -d= -f2-)
if [ -z "$PASSWORD" ]; then
  echo "set SUWAYOMI_PASSWORD in $FILE" >&2
  exit 1
fi

SUB=$(az account show --query id --output tsv)
ENV_ID=$(az containerapp env show --name "$ENVIRONMENT" --resource-group "$GROUP" --query id --output tsv)
LOCATION=$(az containerapp env show --name "$ENVIRONMENT" --resource-group "$GROUP" --query location --output tsv)

# The start script comes from GitHub, so a change to it needs no image. If GitHub can't be
# reached, Suwayomi starts as it is, without putting in extensions.
START="curl -fsSL --max-time 60 $RAW/azure/suwayomi/start.sh -o /tmp/start.sh && exec sh /tmp/start.sh || exec /home/suwayomi/startup_script.sh"

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT
jq -n --arg location "$LOCATION" --arg env "$ENV_ID" --arg image "$IMAGE" --arg start "$START" \
  --arg password "$PASSWORD" --arg extensions "$RAW/aws/extensions.sh" '{
  location: $location,
  properties: {
    managedEnvironmentId: $env,
    configuration: {
      ingress: { external: true, targetPort: 4567, transport: "auto" },
      secrets: [{ name: "auth-password", value: $password }]
    },
    template: {
      containers: [{
        name: "suwayomi",
        image: $image,
        command: ["tini", "-g", "--", "sh", "-c", $start],
        resources: { cpu: 0.75, memory: "1.5Gi" },
        env: [
          { name: "EXTENSION_STORES", value: "[\"https://raw.githubusercontent.com/keiyoushi/extensions/repo/repo.json\"]" },
          { name: "EXTENSIONS_SH", value: $extensions },
          { name: "WEB_UI_CHANNEL", value: "bundled" },
          { name: "WEB_UI_UPDATE_INTERVAL", value: "0" },
          { name: "KCEF_ENABLED", value: "false" },
          { name: "AUTH_MODE", value: "basic_auth" },
          { name: "AUTH_USERNAME", value: "breader" },
          { name: "AUTH_PASSWORD", secretRef: "auth-password" },
          { name: "JAVA_TOOL_OPTIONS", value: "-Xmx768m" }
        ]
      }],
      scale: { minReplicas: 0, maxReplicas: 1 }
    }
  }
}' > "$BODY"

# az rest, as `az containerapp create --yaml` answered 400 here (CLI 2.93).
az rest --method put --output none --body "@$BODY" \
  --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$GROUP/providers/Microsoft.App/containerApps/$APP?api-version=2025-07-01"

echo "$APP answers at https://$(az containerapp show --name "$APP" --resource-group "$GROUP" \
  --query properties.configuration.ingress.fqdn --output tsv)"
