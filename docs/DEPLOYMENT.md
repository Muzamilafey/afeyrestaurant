# Production deployment (Ubuntu 22.04/24.04, no Docker)

## Server packages

```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
# MongoDB 7 Community + Database Tools: follow https://www.mongodb.com/docs/manual/installation/
sudo npm i -g pm2
```

Configure MongoDB as a replica set with authentication — see [SETUP.md](SETUP.md).

## Application

```bash
sudo mkdir -p /opt/chili-pos /var/log/chili-pos && sudo chown $USER /opt/chili-pos /var/log/chili-pos
git clone <your repo> /opt/chili-pos && cd /opt/chili-pos
npm ci
cp server/.env.example server/.env && nano server/.env      # production values, NODE_ENV=production
npm run build                                               # server/dist, web/dist, bridge/dist
pm2 start deploy/ecosystem.config.js --env production       # chili-api (2 instances) + chili-worker
pm2 save && pm2 startup                                     # restart on boot
```

Graceful shutdown: the API stops accepting connections, finishes in-flight requests and closes the database within
15 s (`kill_timeout` in the PM2 file matches).

## Nginx + HTTPS (Let's Encrypt)

```bash
sudo cp deploy/nginx/chili-pos.conf /etc/nginx/sites-available/chili-pos
sudo sed -i 's/pos.example.co.ke/your.domain/g' /etc/nginx/sites-available/chili-pos
sudo ln -s /etc/nginx/sites-available/chili-pos /etc/nginx/sites-enabled/
sudo certbot --nginx -d your.domain        # obtains and auto-renews the certificate
sudo nginx -t && sudo systemctl reload nginx
```

Set `TRUST_PROXY=loopback` (default) so client IPs and HTTPS are taken from Nginx only.

## Health checks & monitoring

- `GET /api/v1/health` — liveness (process up).
- `GET /api/v1/ready` — readiness (database ping, stale queued jobs). Returns 503 when not ready.
- Logs are structured JSON (pino) with request IDs (`x-request-id`); secrets, passwords, PINs and templates are
  redacted. Rotate with `pm2 install pm2-logrotate`.
- Point an uptime monitor at `/api/v1/ready`; alert on non-200.

## Backups

```bash
sudo mkdir -p /var/backups/chili-pos
crontab -e
# Every night at 02:30 — keeps 14 days; status shown in Settings → Business
30 2 * * * MONGODB_URI='mongodb://...' BACKUP_DIR=/var/backups/chili-pos BACKUP_STATUS_FILE=/var/backups/chili-pos/last-backup.json /opt/chili-pos/scripts/backup.sh >> /var/log/chili-pos/backup.log 2>&1
```

Set `BACKUP_STATUS_FILE` in `server/.env` to the same path so the owner sees backup status. Copy archives off the
server (e.g. `rclone` to cloud storage) and set `BACKUP_GPG_RECIPIENT` to encrypt them. Also back up
`server/.env` (especially `SECRETS_ENCRYPTION_KEY`) separately and securely.

### Restore drill (do this before go-live and quarterly)

```bash
TARGET_URI='mongodb://.../chili_restore_test?replicaSet=rs0&authSource=admin' ./scripts/restore.sh /var/backups/chili-pos/chili-pos-<stamp>.archive.gz
# compare counts, then drop chili_restore_test
```

The script refuses to overwrite the production database unless `CONFIRM_PRODUCTION_RESTORE=yes`. This round-trip
(backup → restore into a test database → identical document counts and indexes) was verified during development.

## Updating

```bash
cd /opt/chili-pos && git pull && npm ci && npm run build && pm2 reload deploy/ecosystem.config.js --env production
```

## Local bridge on the restaurant LAN

See [bridge/README.md](../bridge/README.md).
