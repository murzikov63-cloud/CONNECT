#!/usr/bin/env bash
# Первичная настройка сервера под Messenger. Идемпотентный: можно гонять повторно.
#   scp deploy/provision.sh root@СЕРВЕР:/tmp/ && ssh root@СЕРВЕР bash /tmp/provision.sh
set -euo pipefail

say() { echo "== $*"; }

export DEBIAN_FRONTEND=noninteractive

say "обновляю систему"
apt-get update -qq
apt-get -y -qq upgrade

say "ставлю базовые пакеты"
apt-get install -y -qq ca-certificates curl gnupg git ufw fail2ban unattended-upgrades jq

# --- подкачка -----------------------------------------------------------
if ! swapon --show | grep -q /swapfile; then
  say "создаю файл подкачки 2 ГБ"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  say "подкачка уже есть"
fi
# Свопить только при реальной нужде, а не заранее: на SSD это дешевле,
# чем кажется, но лишние обращения к диску всё равно ни к чему.
echo 'vm.swappiness=10' > /etc/sysctl.d/99-messenger.conf
sysctl -q -w vm.swappiness=10

# --- docker -------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "ставлю Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  say "Docker уже стоит"
fi

# Логи контейнеров не должны съесть диск.
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
systemctl restart docker

# --- файрвол ------------------------------------------------------------
say "настраиваю файрвол: 80/443 только для Cloudflare"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp comment 'SSH' >/dev/null

added=0
for url in https://www.cloudflare.com/ips-v4 https://www.cloudflare.com/ips-v6; do
  while read -r net; do
    [ -z "$net" ] && continue
    ufw allow from "$net" to any port 80,443 proto tcp comment 'Cloudflare' >/dev/null
    added=$((added + 1))
  done < <(curl -fsS --max-time 20 "$url")
done
say "разрешено сетей Cloudflare: $added"
[ "$added" -lt 10 ] && { echo "ОШИБКА: список сетей Cloudflare не загрузился, файрвол не включаю"; exit 1; }

ufw --force enable >/dev/null

# --- автообновления безопасности ---------------------------------------
say "включаю автообновления безопасности"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

# --- каталог проекта ----------------------------------------------------
mkdir -p /opt/messenger-connect /var/lib/messenger-connect

say "готово"
echo
echo "память:"; free -h | sed -n '1,3p'
echo "диск:"; df -h / | tail -1
echo "docker:"; docker -v; docker compose version | head -1
echo "файрвол:"; ufw status | head -4
[ -f /var/run/reboot-required ] && echo "ВНИМАНИЕ: системе нужна перезагрузка"
