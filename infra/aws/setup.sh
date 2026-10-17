#!/bin/sh
# Runs once on the new AWS machine (Ubuntu 24.04, arm64): swap, Docker, the repository's infra/
# folder only, and the daily timer for extensions.sh. README.md › Suwayomi on AWS for Render.
set -eu

# 2 GB more room on disk, so a busy moment slows Suwayomi down instead of stopping it.
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

sudo apt-get update -y
sudo apt-get install -y docker.io docker-compose-v2 git curl jq
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

if [ ! -d "$HOME/breader" ]; then
  git clone --filter=blob:none --sparse https://github.com/anubhav-qt/breader.git "$HOME/breader"
fi
cd "$HOME/breader"
git sparse-checkout set infra
git pull --ff-only

sudo tee /etc/systemd/system/breader-extensions.service > /dev/null <<EOF
[Unit]
Description=Install and update Suwayomi's extensions
After=docker.service

[Service]
Type=oneshot
User=$USER
ExecStart=$HOME/breader/infra/aws/extensions.sh
EOF

sudo tee /etc/systemd/system/breader-extensions.timer > /dev/null <<EOF
[Unit]
Description=Suwayomi's extensions, once a day

[Timer]
OnCalendar=*-*-* 22:30:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now breader-extensions.timer
echo "setup done"
