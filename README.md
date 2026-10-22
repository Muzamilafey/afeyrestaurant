# Chili POS

Restaurant & bar point of sale and management for Kenyan hospitality businesses — one installation per business,
with any number of branches, terminals and staff.

- **POS** for dine-in, takeaway, delivery, bar counter and room service, with modifiers, sizes, happy hour,
  discounts with manager approval, split bills, merge/transfer tables, held orders and barcode/PLU search.
- **PIN sign-in** on registered tills: tap your name, enter your PIN. Quick user switching, idle auto-lock.
- **Kitchen & bar displays** with automatic routing (food → kitchen, drinks → bar), ticket ageing, delay warnings,
  sound alerts and optional ticket printers.
- **Payments**: cash drawer sessions, M-Pesa Daraja STK Push + C2B, card/QR (terminal reference), credit accounts,
  split payments, refunds, immutable payment ledger, reconciliation.
- **Inventory**: ingredients, units (bottle/shot/keg), recipes with versions, FIFO costing, append-only stock
  ledger, exactly-once deductions, wastage with second-person approval, counts, transfers, purchasing and GRNs.
- **Customers, reservations (timeline), delivery, loyalty, coupons**, consent-aware marketing.
- **Staff & attendance** with ZKTeco terminals and SecuGen readers via a local bridge, PIN clock-in alternative,
  shifts, corrections with approval and reports.
- **Reports**: sales, payments, staff, kitchen times, table turnover, stock valuation, COGS, bar variance, P&L, tax.
- **Integrations centre**: Talk Sasa SMS, SMTP email, printers, devices — status is shown as connected only after a
  real test passes; simulated providers are clearly labelled and disabled in production.
- **Offline**: menu cached on the device; cash sales recorded offline sync idempotently when back online.
- **Light and dark themes**, installable PWA, responsive from phone to desktop.

## Repository layout

| Path | What |
|------|------|
| `server/` | API — Node.js, Express 5, TypeScript, MongoDB (Mongoose), Socket.IO. REST under `/api/v1`, OpenAPI at `/api/docs`. |
| `web/` | Web app — React 19, Vite, TypeScript, Tailwind, TanStack Query, React Hook Form + Zod, Recharts, PWA. |
| `bridge/` | Chili Bridge — local service for ESC/POS printers, cash drawers, ZKTeco terminals and SecuGen readers. |
| `deploy/` | PM2 process file and Nginx site config. |
| `scripts/` | `backup.sh` / `restore.sh`. |
| `docs/` | Setup, deployment, integrations, bridge, acceptance tests. |

## Quick start (development)

Requirements: Node.js 20+ and MongoDB 6+ **running as a replica set** (transactions are used for payments and stock).

```bash
npm install
# MongoDB single-node replica set (once): mongod --replSet rs0 --dbpath ./data  then  mongosh --eval 'rs.initiate()'
cp server/.env.example server/.env
npm run seed          # demo business "Chili Grill & Lounge" with menu, recipes, stock, tables and staff
npm run dev:server    # API on http://localhost:4000 (docs at /api/docs)
npm run dev:web       # app on http://localhost:5173
```

Demo accounts (password `ChiliDemo#2026`, PIN `2580`): `owner@`, `gm@`, `manager@`, `cashier@`, `waiter@`,
`bartender@`, `chef@`, `store@`, `procurement@`, `accountant@`, `hr@`, `auditor@` — all `@chili.demo`.
To try PIN sign-in, sign in as the manager, open the account menu (your name, bottom-left) and choose
**Use this device**, then **Switch user**.

On a fresh database without the seed, the app opens a **first-run setup** screen to create your business, first
branch and owner account. Business name and logo can be changed later in **Settings → Business**.

## Tests

```bash
npm test         # API integration tests (real MongoDB replica set via mongodb-memory-server), web and bridge unit tests
npm run typecheck
```

See [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) for the acceptance checklist and what is verified automatically, what
needs credentials or hardware, and what is unverified.

## Documentation

- [Setup & configuration](docs/SETUP.md)
- [Production deployment (Nginx, PM2, Let's Encrypt, backups)](docs/DEPLOYMENT.md)
- [M-Pesa Daraja](docs/integrations/mpesa.md) · [Talk Sasa SMS](docs/integrations/sms.md) · [SMTP email](docs/integrations/email.md)
- [Printers](docs/integrations/printers.md) · [Biometric devices & attendance](docs/integrations/biometrics.md) · [Chili Bridge](bridge/README.md)
- [Security notes](docs/SECURITY.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)
