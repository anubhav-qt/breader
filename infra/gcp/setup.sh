#!/bin/sh
# Runs once on the GCP e2-micro (Debian, IPv6 only: a public IPv4 address costs money). It has no
# IPv4 of its own, so:
#   - Cloudflare WARP carries outgoing IPv4 (ghcr.io, GitHub) while this runs and while update.sh
#     pulls an image, and is off otherwise: connected, it pings Cloudflare all day, which is egress;
#   - cloudflared (a Cloudflare Tunnel) brings readers in, as on the ThinkPad, over one connection.
# Both are system services that start again after a reboot. Then swap, Docker, and the repository's
# infra/ folder. README.md › GCP. Run it as the machine's own user, with the tunnel's token in
# ~/tunnel.token (`cloudflared tunnel token <name> | ssh <machine> 'umask 077; cat > ~/tunnel.token'`,
# so it never shows): sh setup.sh. cloudflared's service keeps the token; the file is deleted.
set -eu

TOKEN_FILE="$HOME/tunnel.token"
if ! systemctl is-enabled cloudflared > /dev/null 2>&1 && [ ! -s "$TOKEN_FILE" ]; then
  echo "put the tunnel's token in $TOKEN_FILE first" >&2
  exit 1
fi

. /etc/os-release

sudo apt-get update -y
sudo apt-get install -y curl gpg ca-certificates

# WARP first: without it nothing IPv4-only answers, GitHub included.
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
  | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $VERSION_CODENAME main" \
  | sudo tee /etc/apt/sources.list.d/cloudflare-client.list > /dev/null
sudo apt-get update -y
# Without its recommends: they are a desktop's (sound, pictures), hundreds of packages.
sudo apt-get install -y --no-install-recommends cloudflare-warp
sudo systemctl enable --now warp-svc
# warp-svc waits a moment for its socket before it takes commands.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if warp-cli --accept-tos status > /dev/null 2>&1; then
    break
  fi
  sleep 2
done
if ! warp-cli --accept-tos registration show > /dev/null 2>&1; then
  warp-cli --accept-tos registration new
fi
# IPv4 alone goes through WARP. IPv6 stays the machine's own (Supabase, the tunnel, SSH), and DNS
# stays Google's.
warp-cli --accept-tos mode tunnel_only
if ! warp-cli --accept-tos tunnel ip list | grep -q '::/0'; then
  warp-cli --accept-tos tunnel ip add-range ::/0
fi
warp-cli --accept-tos connect

# The tunnel, as a system service that starts with the machine.
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list > /dev/null
sudo apt-get update -y
sudo apt-get install -y cloudflared
if ! systemctl is-enabled cloudflared > /dev/null 2>&1; then
  sudo cloudflared service install "$(cat "$TOKEN_FILE")"
fi
rm -f "$TOKEN_FILE"
# Egress costs money here: one connection over HTTP/2 rather than QUIC's 4, each pinged every
# second, and to Cloudflare's IPv6 edge only, as IPv4 would need WARP.
sudo mkdir -p /etc/systemd/system/cloudflared.service.d
sudo tee /etc/systemd/system/cloudflared.service.d/quiet.conf > /dev/null <<'UNIT'
[Service]
Environment=TUNNEL_TRANSPORT_PROTOCOL=http2
Environment=TUNNEL_EDGE_IP_VERSION=6
ExecStart=
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel --ha-connections 1 run --token-file /etc/cloudflared/token
UNIT
sudo systemctl daemon-reload
sudo systemctl restart cloudflared

# 1 GB of memory is little: 2 GB of swap on disk, so a busy moment slows things down instead of
# stopping them.
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
fi

# Docker from Docker's own packages, for `docker compose` (reached through WARP if it has no IPv6).
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --yes --dearmor --output /etc/apt/keyrings/docker.gpg
echo "deb [signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $VERSION_CODENAME stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

if [ ! -d "$HOME/breader" ]; then
  git clone --filter=blob:none --sparse https://github.com/anubhav-qt/breader.git "$HOME/breader"
fi
cd "$HOME/breader"
git sparse-checkout set infra
git pull --ff-only

# WARP off until update.sh needs it (WARP_WHILE_PULLING in .env).
warp-cli --accept-tos disconnect

echo "setup done: fill infra/gcp/.env from .env.example, then docker compose -f infra/gcp/compose.yml up -d"
