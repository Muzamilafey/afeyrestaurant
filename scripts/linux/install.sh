#!/usr/bin/env bash
# Chili POS - one-command install on an internet server (VPS) with your own domain.
#
#   sudo bash scripts/linux/install.sh --domain pos.example.co.ke --email you@example.co.ke
#
# Or on a fresh server, without cloning first:
#   curl -fsSL https://raw.githubusercontent.com/muzamilafey/afeyrestaurant/main/scripts/linux/install.sh \
#     | sudo bash -s -- --domain pos.example.co.ke --email you@example.co.ke
#
# Ubuntu 22.04 / 24.04 (Debian 12 works too). Before running: point the domain's DNS "A" record at this server.
# It installs Node.js 22, MongoDB 8 (single-node replica set, bound to localhost), Caddy (automatic Let's Encrypt
# HTTPS), builds Chili POS, runs it as the "chili-pos" systemd service, opens the firewall for SSH/HTTP/HTTPS only,
# schedules nightly backups, and prints the link and the first-run setup token.
#
# Safe to run again: secrets are generated once (/etc/chili-pos/chili.env) and reused; data is never touched.
# Options: --update (git pull, rebuild, restart)  --dry-run (show what would be done)  --no-firewall
#          --repo URL  --branch NAME  --dir /opt/chili-pos
set -euo pipefail

DOMAIN=""
EMAIL=""
REPO="https://github.com/muzamilafey/afeyrestaurant.git"
BRANCH="main"
APP_DIR="/opt/chili-pos"
UPDATE=0
DRY=0
FIREWALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --dir) APP_DIR="$2"; shift 2 ;;
    --update) UPDATE=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --no-firewall) FIREWALL=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

ENV_DIR="/etc/chili-pos"
ENV_FILE="$ENV_DIR/chili.env"
DATA_DIR="/var/lib/chili-pos"
BACKUP_DIR="/var/backups/chili-pos"
SERVICE="chili-pos"
APP_USER="chili"
DB_NAME="chili_pos"
if [[ $DRY -eq 1 ]]; then
  # Dry run: write the generated files under a temporary folder instead of the system.
  OUT="${DRY_ROOT:-$(mktemp -d)}"
  ENV_DIR="$OUT/etc/chili-pos"; ENV_FILE="$ENV_DIR/chili.env"
fi

c_step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
c_ok() { printf '    \033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '    \033[33m! %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }
run() {
  if [[ $DRY -eq 1 ]]; then printf '    [dry run] %s\n' "$*"; else "$@"; fi
}
secret() { head -c "$1" /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'; }

# -- 0. Checks ---------------------------------------------------------------------------------
[[ -n "$DOMAIN" ]] || die "Give the web address, e.g. --domain pos.example.co.ke (its DNS A record must point at this server)."
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "\"$DOMAIN\" is not a domain name."
[[ -n "$EMAIL" ]] || die "Give an email for Let's Encrypt certificate notices, e.g. --email you@example.co.ke"
if [[ $DRY -eq 0 && $EUID -ne 0 ]]; then die "Run with sudo."; fi
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) die "Ubuntu 22.04/24.04 or Debian 12 is required (found ${PRETTY_NAME:-unknown})." ;; esac
CODENAME="${VERSION_CODENAME:-}"
if [[ $DRY -eq 0 ]] && ! pidof systemd >/dev/null 2>&1 && [[ "$(ps -p 1 -o comm= 2>/dev/null)" != "systemd" ]]; then
  die "systemd is not running. Use a normal VPS (not a container without systemd)."
fi

c_step "Checking the server"
PUBLIC_IP="$(curl -fsS4 --max-time 8 https://api.ipify.org 2>/dev/null || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
c_ok "this server: ${PUBLIC_IP:-unknown}   $DOMAIN -> ${DNS_IP:-not found}"
if [[ -z "$DNS_IP" ]]; then
  c_warn "$DOMAIN does not resolve yet. Create a DNS A record pointing to ${PUBLIC_IP:-this server}; HTTPS starts working once it does."
elif [[ -n "$PUBLIC_IP" && "$DNS_IP" != "$PUBLIC_IP" ]]; then
  c_warn "$DOMAIN points to $DNS_IP, not this server ($PUBLIC_IP). Fix the DNS A record (or turn off a proxy such as Cloudflare's orange cloud) for the certificate to be issued."
fi
for port in 80 443; do
  if [[ $DRY -eq 0 ]] && ss -ltnH "sport = :$port" 2>/dev/null | grep -q . && ! ss -ltnpH "sport = :$port" 2>/dev/null | grep -q caddy; then
    die "Port $port is used by another program ($(ss -ltnpH "sport = :$port" | sed -E 's/.*users:\(\("([^"]+)".*/\1/' | head -1)). Stop it (e.g. apache2 or nginx) and run again."
  fi
done

# -- 1. Packages -------------------------------------------------------------------------------
c_step "Installing packages (Node.js 22, MongoDB 8, Caddy)"
export DEBIAN_FRONTEND=noninteractive
run apt-get update -qq
run apt-get install -y -qq curl ca-certificates gnupg git ufw iproute2 debian-keyring debian-archive-keyring apt-transport-https >/dev/null
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [[ -z "$NODE_MAJOR" || "$NODE_MAJOR" -lt 20 ]]; then
  if [[ $DRY -eq 1 ]]; then run "install Node.js 22 from NodeSource"
  else curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null && apt-get install -y -qq nodejs >/dev/null; fi
fi
c_ok "Node.js $(node -v 2>/dev/null || echo '(will be installed)')"
if ! command -v mongod >/dev/null 2>&1; then
  MONGO_DIST="ubuntu"; [[ "$ID" == "debian" ]] && MONGO_DIST="debian"
  MONGO_COMPONENT="multiverse"; [[ "$ID" == "debian" ]] && MONGO_COMPONENT="main"
  if [[ $DRY -eq 1 ]]; then run "add MongoDB 8.0 apt repository ($MONGO_DIST $CODENAME) and install mongodb-org"
  else
    curl -fsSL https://pgp.mongodb.com/server-8.0.asc | gpg --dearmor --yes -o /usr/share/keyrings/mongodb-server-8.0.gpg
    echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/$MONGO_DIST $CODENAME/mongodb-org/8.0 $MONGO_COMPONENT" > /etc/apt/sources.list.d/mongodb-org-8.0.list
    apt-get update -qq && apt-get install -y -qq mongodb-org >/dev/null
  fi
fi
if ! command -v caddy >/dev/null 2>&1; then
  if [[ $DRY -eq 1 ]]; then run "add Caddy apt repository and install caddy"
  else
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
fi
c_ok "MongoDB, mongosh and Caddy installed"

# -- 2. MongoDB as a single-node replica set (transactions) ------------------------------------
c_step "Preparing MongoDB (replica set rs0, only reachable from this server)"
MONGO_CONF="/etc/mongod.conf"
if [[ $DRY -eq 0 ]]; then
  if ! grep -qE '^\s*replSetName:' "$MONGO_CONF"; then
    cp "$MONGO_CONF" "$MONGO_CONF.bak-$(date +%Y%m%d%H%M%S)"
    if grep -qE '^#?replication:' "$MONGO_CONF"; then sed -i -E 's/^#?replication:.*/replication:\n  replSetName: rs0/' "$MONGO_CONF"
    else printf '\nreplication:\n  replSetName: rs0\n' >> "$MONGO_CONF"; fi
    c_ok "added replication.replSetName rs0 to $MONGO_CONF (backup kept)"
  fi
  grep -qE '^\s*bindIp:\s*127\.0\.0\.1\s*$' "$MONGO_CONF" || c_warn "$MONGO_CONF binds to more than 127.0.0.1 - keep port 27017 closed to the internet."
  systemctl enable --now mongod >/dev/null 2>&1
  systemctl restart mongod
  for _ in $(seq 1 30); do mongosh --quiet --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break; sleep 1; done
  mongosh --quiet --eval '
    let st; try { st = rs.status(); } catch (e) { st = e; }
    if (st.ok === 1) { print("replica set " + st.set + " already initiated"); }
    else if (st.codeName === "NotYetInitialized") { rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] }); print("initiated replica set rs0"); }
    else { print("rs.status() failed: " + (st.codeName || st.message)); quit(2); }
    for (let i = 0; i < 30 && !db.hello().isWritablePrimary; i++) sleep(1000);
    quit(db.hello().isWritablePrimary ? 0 : 3);'
  SETNAME="$(mongosh --quiet --eval 'db.hello().setName' | tail -1)"
else
  run "add replication.replSetName rs0 to $MONGO_CONF, restart mongod, rs.initiate() only if not initiated"
  SETNAME="rs0"
fi
c_ok "replica set: $SETNAME"

# -- 3. Code -----------------------------------------------------------------------------------
c_step "Getting and building Chili POS in $APP_DIR"
if [[ $DRY -eq 0 ]]; then
  id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$APP_USER"
  mkdir -p "$DATA_DIR/uploads" "$BACKUP_DIR"
  chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
  if [[ ! -d "$APP_DIR/.git" ]]; then git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
  elif [[ $UPDATE -eq 1 ]]; then git -C "$APP_DIR" pull --ff-only; fi
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  (cd "$APP_DIR" && sudo -u "$APP_USER" -H npm ci --no-audit --no-fund && sudo -u "$APP_USER" -H npm run build)
else
  run "git clone $REPO ($BRANCH) to $APP_DIR, npm ci, npm run build (as user $APP_USER)"
fi
c_ok "built"

# -- 4. Settings (secrets generated once, then reused) -----------------------------------------
c_step "Production settings ($ENV_FILE)"
mkdir -p "$ENV_DIR"
get_env() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
JWT="$(get_env JWT_ACCESS_SECRET)"; [[ -n "$JWT" ]] || JWT="$(secret 48)"
KEY="$(get_env SECRETS_ENCRYPTION_KEY)"; [[ -n "$KEY" ]] || KEY="$(head -c 32 /dev/urandom | base64)"
TOKEN="$(get_env SETUP_TOKEN)"; [[ -n "$TOKEN" ]] || TOKEN="$(secret 12 | tr -dc 'A-Za-z0-9')"
URI="$(get_env MONGODB_URI)"; [[ -n "$URI" ]] || URI="mongodb://127.0.0.1:27017/$DB_NAME?replicaSet=$SETNAME"
umask 077
cat > "$ENV_FILE" <<EOF
# Chili POS production settings - generated by scripts/linux/install.sh. Keep this file private and backed up:
# SECRETS_ENCRYPTION_KEY is needed to read the M-Pesa/SMS/email credentials saved in the app.
NODE_ENV=production
PORT=4000
MONGODB_URI=$URI
PUBLIC_API_URL=https://$DOMAIN
CORS_ORIGINS=https://$DOMAIN
COOKIE_SECURE=true
TRUST_PROXY=loopback
JWT_ACCESS_SECRET=$JWT
SECRETS_ENCRYPTION_KEY=$KEY
SETUP_TOKEN=$TOKEN
RUN_WORKER_IN_PROCESS=true
UPLOAD_DIR=$DATA_DIR/uploads
BACKUP_STATUS_FILE=$BACKUP_DIR/last-backup.json
EOF
umask 022
if [[ $DRY -eq 0 ]]; then chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"; fi
c_ok "secrets kept in $ENV_FILE"

# -- 5. Service --------------------------------------------------------------------------------
c_step "Running Chili POS as a service"
UNIT_DIR="/etc/systemd/system"; [[ $DRY -eq 1 ]] && UNIT_DIR="$OUT/etc/systemd/system" && mkdir -p "$UNIT_DIR"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
cat > "$UNIT_DIR/$SERVICE.service" <<EOF
[Unit]
Description=Chili POS (API, realtime and background jobs)
After=network-online.target mongod.service
Wants=network-online.target mongod.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR/server
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN dist/index.js
Restart=always
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR $BACKUP_DIR

[Install]
WantedBy=multi-user.target
EOF
if [[ $DRY -eq 0 ]]; then
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  systemctl restart "$SERVICE"
  for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:4000/api/v1/ready 2>/dev/null | grep -q '"ready"' && break; sleep 2; done
  curl -fsS http://127.0.0.1:4000/api/v1/ready | grep -q '"ready"' || die "Chili POS did not start. See: journalctl -u $SERVICE -n 50"
fi
c_ok "service $SERVICE running on 127.0.0.1:4000 (not reachable directly from the internet)"

# -- 6. HTTPS (Caddy + Let's Encrypt) ----------------------------------------------------------
c_step "HTTPS for https://$DOMAIN"
CADDY_DIR="/etc/caddy"; [[ $DRY -eq 1 ]] && CADDY_DIR="$OUT/etc/caddy" && mkdir -p "$CADDY_DIR"
cat > "$CADDY_DIR/Caddyfile" <<EOF
# Generated by scripts/linux/install.sh - re-run the installer instead of editing this file.
{
	email $EMAIL
}

$DOMAIN {
	encode gzip
	handle /api/* {
		reverse_proxy 127.0.0.1:4000
	}
	handle /uploads/* {
		reverse_proxy 127.0.0.1:4000
	}
	handle {
		root * $APP_DIR/web/dist
		@app path /index.html /sw.js /registerSW.js
		header @app Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
	header Strict-Transport-Security "max-age=31536000"
}
EOF
if [[ $DRY -eq 0 ]]; then
  caddy validate --config "$CADDY_DIR/Caddyfile" --adapter caddyfile >/dev/null
  systemctl enable caddy >/dev/null 2>&1
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi
c_ok "Caddy configured; the certificate is issued automatically on first visit"

# -- 7. Firewall and backups -------------------------------------------------------------------
if [[ $FIREWALL -eq 1 ]]; then
  c_step "Firewall: SSH, HTTP and HTTPS only"
  SSH_PORT="$( { ss -ltnpH 2>/dev/null || true; } | awk '/sshd/ {sub(/.*:/, "", $4); print $4; exit}')"
  run ufw allow "${SSH_PORT:-22}/tcp" >/dev/null
  run ufw allow 80/tcp >/dev/null
  run ufw allow 443/tcp >/dev/null
  run ufw --force enable >/dev/null
  c_ok "open: ${SSH_PORT:-22} (SSH), 80, 443 - MongoDB 27017 and the API port 4000 stay closed"
fi
c_step "Nightly backups (03:00, 14 days kept) to $BACKUP_DIR"
CRON_FILE="/etc/cron.d/chili-pos-backup"; [[ $DRY -eq 1 ]] && CRON_FILE="$OUT/etc/cron.d/chili-pos-backup" && mkdir -p "$(dirname "$CRON_FILE")"
cat > "$CRON_FILE" <<EOF
# Chili POS database backup - generated by scripts/linux/install.sh
0 3 * * * root MONGODB_URI='$URI' BACKUP_DIR='$BACKUP_DIR' BACKUP_STATUS_FILE='$BACKUP_DIR/last-backup.json' bash '$APP_DIR/scripts/backup.sh' >> /var/log/chili-pos-backup.log 2>&1
EOF
c_ok "copy $BACKUP_DIR off the server regularly (and keep $ENV_FILE safe)"

# -- 8. Done -----------------------------------------------------------------------------------
HTTPS_OK=0
if [[ $DRY -eq 0 ]]; then
  for _ in $(seq 1 30); do curl -fsS --max-time 10 "https://$DOMAIN/api/v1/ready" 2>/dev/null | grep -q '"ready"' && HTTPS_OK=1 && break; sleep 4; done
fi
CONFIGURED="$(curl -fsS http://127.0.0.1:4000/api/v1/business 2>/dev/null | grep -o '"configured":[a-z]*' | cut -d: -f2 || true)"
echo
printf '\033[1;32m  Chili POS is installed\033[0m\n\n'
printf '  Open:  \033[1mhttps://%s\033[0m   (tills, phones, the owner at home)\n' "$DOMAIN"
[[ $HTTPS_OK -eq 1 || $DRY -eq 1 ]] || c_warn "https://$DOMAIN is not answering yet - check the DNS A record; Caddy keeps retrying. Logs: journalctl -u caddy -n 50"
if [[ "$CONFIGURED" != "true" ]]; then printf '  First-run setup token: \033[1;33m%s\033[0m  (asked once on the setup screen)\n' "$TOKEN"; fi
if [[ "$CONFIGURED" != "true" ]]; then printf '  Live copy of a restaurant server instead? Skip the setup screen; on the restaurant server open\n  Settings -> Live server and enter https://%s with this token.\n' "$DOMAIN"; fi
cat <<EOF

  Offline: each till keeps selling when the internet drops (cash, card, M-Pesa code) and uploads the
  sales automatically when it comes back. Install the app on each till/phone from the browser menu.

  Printers / fingerprint devices: run the Chili Bridge on a PC in the restaurant with
  CHILI_API_URL=https://$DOMAIN (Integrations -> Local bridges -> Register bridge gives the token).

  Logs:     journalctl -u $SERVICE -f
  Update:   sudo bash $APP_DIR/scripts/linux/install.sh --domain $DOMAIN --email $EMAIL --update
EOF
[[ $DRY -eq 1 ]] && printf '\n  [dry run] generated files are in %s\n' "$OUT"
exit 0
