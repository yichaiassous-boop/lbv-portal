#!/bin/bash
# Installs the WhatsApp link service on a Google Cloud e2-micro (Debian). It runs by itself at every boot
# (the machine's startup script) and is safe to run again. The three keys are pasted once with: sudo lbv-wa-keys
set -e
BR=feat/nouvelle-page-accueil
export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null || { apt-get update -y && apt-get install -y curl git ca-certificates; }
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
# a little swap: the micro machine has 1 GB of memory
if [ ! -f /swapfile ]; then fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
id lbvwa >/dev/null 2>&1 || useradd -r -m -d /opt/lbv lbvwa
if [ -d /opt/lbv/lbv-portal/.git ]; then sudo -u lbvwa git -C /opt/lbv/lbv-portal pull -q; else sudo -u lbvwa git clone -q -b $BR https://github.com/yichaiassous-boop/lbv-portal.git /opt/lbv/lbv-portal; fi
cd /opt/lbv/lbv-portal/wa && sudo -u lbvwa npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# the budget's subscription (set on the machine when it was made): any cost → the service turns the machine off
SUB=$(curl -fs -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/budget-sub || true)
touch /etc/lbv-wa.env && chmod 600 /etc/lbv-wa.env
grep -q '^PORTAL_URL=' /etc/lbv-wa.env || echo 'PORTAL_URL=https://lbv-portal-phi.vercel.app' >> /etc/lbv-wa.env
if [ -n "$SUB" ]; then sed -i '/^BUDGET_SUB=/d' /etc/lbv-wa.env; echo "BUDGET_SUB=$SUB" >> /etc/lbv-wa.env; fi
echo 'lbvwa ALL=(root) NOPASSWD: /sbin/shutdown' > /etc/sudoers.d/lbvwa && chmod 440 /etc/sudoers.d/lbvwa
# pasting the three keys: asked one by one, not shown on the screen
cat > /usr/local/bin/lbv-wa-keys <<'KEYS'
#!/bin/bash
set -e
ask() { local v; read -r -s -p "$2: " v; echo; v="$(echo -n "$v" | tr -d '\r' | sed 's/^ *//;s/ *$//;s/^"//;s/"$//')"; sed -i "/^$1=/d" /etc/lbv-wa.env; echo "$1=$v" >> /etc/lbv-wa.env; }
ask KV_REST_API_URL 'הדבק את KV_REST_API_URL'
ask KV_REST_API_TOKEN 'הדבק את KV_REST_API_TOKEN'
ask BLOB_READ_WRITE_TOKEN 'הדבק את BLOB_READ_WRITE_TOKEN'
systemctl restart lbv-wa && echo 'נשמר. החיבור עולה, עוד דקה יופיע קוד לסריקה באתר.'
KEYS
chmod 700 /usr/local/bin/lbv-wa-keys
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
if grep -q '^KV_REST_API_TOKEN=.\+' /etc/lbv-wa.env; then systemctl restart lbv-wa; echo running; else echo 'waiting for: sudo lbv-wa-keys'; fi
