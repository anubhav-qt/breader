#!/bin/sh
# Runs once on the GCP e2-micro (Debian, IPv6 only: a public IPv4 address costs money). It has no
# IPv4 of its own, so:
#   - Cloudflare WARP carries every outgoing IPv4 connection (MangaDex, ghcr.io, GitHub), and
#   - cloudflared (a Cloudflare Tunnel) brings readers in, as on the ThinkPad.
# Both are system services that start again after a reboot. Then swap, Docker, and the repository's
# infra/ folder. README.md › GCP. Run it as the machine's own user:
#   TUNNEL_TOKEN=... sh setup.sh
# (the tunnel's token, from its page in Cloudflare; it is kept by cloudflared's service, not here).
set -eu

if [ -z "${TUNNEL_TOKEN:-}" ]; then
  echo "set TUNNEL_TOKEN to the tunnel's token" >&2
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
sudo apt-get install -y cloudflare-warp
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
warp-cli --accept-tos connect

# Connects WARP again after every reboot, once warp-svc is up.
sudo tee /etc/systemd/system/breader-warp.service > /dev/null <<UNIT
[Unit]
Description=Cloudflare WARP connected, for outgoing IPv4
After=warp-svc.service network-online.target
Wants=warp-svc.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStartPre=/bin/sleep 5
ExecStart=/usr/bin/warp-cli --accept-tos connect

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable breader-warp.service

# The tunnel, as a system service that starts with the machine.
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list > /dev/null
sudo apt-get update -y
sudo apt-get install -y cloudflared
if ! systemctl is-enabled cloudflared > /dev/null 2>&1; then
  sudo cloudflared service install "$TUNNEL_TOKEN"
fi

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
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

if [ ! -d "$HOME/breader" ]; then
  git clone --filter=blob:none --sparse https://github.com/anubhav-qt/breader.git "$HOME/breader"
fi
cd "$HOME/breader"
git sparse-checkout set infra
git pull --ff-only

echo "setup done: fill infra/gcp/.env from .env.example, then docker compose -f infra/gcp/compose.yml up -d"
