# Setup & configuration

> Installing for a restaurant with several tills on one server PC? Follow **[MULTI-TILL.md](MULTI-TILL.md)** step by step.

## 1. MongoDB (replica set required)

First-run setup, payments, stock deductions, transfers and refunds run in MongoDB transactions, which need a replica
set. A single-node replica set is enough. **Windows:** see [MONGODB-WINDOWS.md](MONGODB-WINDOWS.md) (includes a helper
script). Check any deployment with `npm run db:check`. Linux:

```bash
# /etc/mongod.conf
replication:
  replSetName: rs0
net:
  bindIp: 127.0.0.1
security:
  authorization: enabled
```

```bash
sudo systemctl restart mongod
mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})'
mongosh admin --eval 'db.createUser({user:"chili",pwd:passwordPrompt(),roles:[{role:"readWrite",db:"chili_pos"}]})'
```

`MONGODB_URI=mongodb://chili:<password>@127.0.0.1:27017/chili_pos?replicaSet=rs0&authSource=admin`

## 2. API configuration (`server/.env`)

Copy `server/.env.example` and set at least:

| Variable | Notes |
|---|---|
| `MONGODB_URI` | Replica-set URI (above). |
| `PUBLIC_API_URL` | Public **HTTPS** base URL, e.g. `https://pos.example.co.ke`. Used for M-Pesa callback URLs. |
| `CORS_ORIGINS` | Browser origin(s) of the web app, e.g. `https://pos.example.co.ke`. |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48`. |
| `SECRETS_ENCRYPTION_KEY` | `openssl rand -base64 32`. Encrypts integration secrets. **Back it up** — secrets cannot be decrypted without it. |
| `COOKIE_SECURE` | `true` behind HTTPS (required in production). |
| `SETUP_TOKEN` | Needed only to use the web first-run screen in production; remove after setup. |
| `RUN_WORKER_IN_PROCESS` | `false` when running the separate worker with PM2. |

The API refuses to start in production with development secrets.

## 3. First-run setup

Either open the web app (it shows **Welcome to Chili POS**; enter the `SETUP_TOKEN`), or use the CLI:

```bash
cd server && npm run build
OWNER_PASSWORD='S0me-Strong-Passw0rd' node dist/scripts/setup.js --name "Afey Restaurant" --owner "Jane Doe" --email owner@example.com --branch "Westlands" --code WST
```

There is exactly one business per installation; setup refuses to run twice.

## 4. After setup (as the owner)

1. **Settings → Business**: name, logo, KRA PIN, receipt header/footer, alert emails, costing policy, offline actions.
2. **Settings → Taxes**: VAT 16% (inclusive) is created; the 2% Catering Levy exists but is inactive. Confirm rates
   that apply to your business.
3. **Settings → Branches / Tables / Users / Roles**, then **Menu & products**, categories and modifiers.
4. **Inventory**: ingredients, opening stock, **Recipes** for items that should deduct stock.
5. **Integrations**: M-Pesa, SMS, email, printers and bridge (see the integration guides).
6. On each till/tablet: sign in as a manager → account menu → **Use this device** to enable PIN sign-in.
   Every user sets their own numeric PIN from the account menu (managers can also reset PINs in Settings → Users).
