#!/bin/bash
# Installs the WhatsApp link service on a fresh Google Cloud e2-micro (Debian/Ubuntu). Run once:
#   curl -fsSL https://raw.githubusercontent.com/yichaiassous-boop/lbv-portal/main/wa/setup-google.sh | sudo bash
# Then put the three keys in /etc/lbv-wa.env (sudo nano /etc/lbv-wa.env) and: sudo systemctl restart lbv-wa
set -e
apt-get update -y && apt-get install -y curl git ca-certificates
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
# a little swap: the micro machine has 1 GB of memory
if [ ! -f /swapfile ]; then fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
id lbvwa >/dev/null 2>&1 || useradd -r -m -d /opt/lbv lbvwa
if [ -d /opt/lbv/lbv-portal ]; then sudo -u lbvwa git -C /opt/lbv/lbv-portal pull -q; else sudo -u lbvwa git clone -q https://github.com/yichaiassous-boop/lbv-portal.git /opt/lbv/lbv-portal; fi
cd /opt/lbv/lbv-portal/wa && sudo -u lbvwa npm ci --omit=dev --ignore-scripts
if [ ! -f /etc/lbv-wa.env ]; then
  printf 'KV_REST_API_URL=\nKV_REST_API_TOKEN=\nBLOB_READ_WRITE_TOKEN=\nPORTAL_URL=https://lbv-portal-phi.vercel.app\n' > /etc/lbv-wa.env
  chmod 600 /etc/lbv-wa.env
fi
cat > /etc/systemd/system/lbv-wa.service <<'UNIT'
[Unit]
Description=LBV WhatsApp link
After=network-online.target
Wants=network-online.target
[Service]
User=lbvwa
WorkingDirectory=/opt/lbv/lbv-portal/wa
EnvironmentFile=/etc/lbv-wa.env
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable lbv-wa
grep -q '^KV_REST_API_TOKEN=.\+' /etc/lbv-wa.env && systemctl restart lbv-wa && echo "running" || echo "now fill /etc/lbv-wa.env, then: sudo systemctl restart lbv-wa"
