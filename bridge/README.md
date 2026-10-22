# Chili Bridge

A small Node.js service that runs on a PC on the restaurant LAN (Windows or Linux) and connects Chili POS to local
hardware. It connects **outbound** to the API over HTTPS — no inbound ports need to be opened on the router.

- ESC/POS **network printers** (port 9100): receipts, bills, kitchen and bar tickets; **cash drawer** pulse.
- **ZKTeco** terminals on the LAN: connection test, clock sync, user create/delete, attendance download every few minutes.
- **SecuGen** USB readers via the SecuGen WebAPI service: enrolment, matching and a clock-in kiosk page.
- Local endpoint for the POS browser (`/health`, `/print`), restricted to `ALLOWED_ORIGINS` and `LOCAL_TOKEN`,
  bound to `127.0.0.1` only.

## Install

1. In Chili POS: **Integrations → Local bridges → Register bridge**. Copy the token (shown once).
2. On the PC (Node.js 20+):

```bash
cd bridge
npm ci && npm run build
cp .env.example .env        # set CHILI_API_URL, CHILI_BRIDGE_TOKEN, ALLOWED_ORIGINS, LOCAL_TOKEN
npm start
```

Run it as a service: on Linux with PM2 (`pm2 start dist/index.js --name chili-bridge && pm2 save && pm2 startup`); on
Windows with PM2 + `pm2-windows-startup`, or NSSM (`nssm install ChiliBridge "C:\Program Files\nodejs\node.exe" dist\index.js`).

3. Add printers (Integrations → Printers, choose this bridge) and devices (Staff & Attendance → Devices), then use
   **Test print** / **Test**.

Several tills / a bridge on a PC other than the server: see [docs/MULTI-TILL.md](../docs/MULTI-TILL.md#8-printers-and-the-bridge).
Fingerprint devices step by step: [docs/FINGERPRINT-DEVICES.md](../docs/FINGERPRINT-DEVICES.md).

## SecuGen

Install the **SecuGen WebAPI** (SGIBioSrv) on the PC, set `SECUGEN_LICENSE` if your deployment requires one, and set
`TEMPLATE_KEY` (`openssl rand -base64 32`) — templates are stored encrypted in `data/templates.enc` and never uploaded.
Open `http://127.0.0.1:9632/clock` on that PC (full-screen browser) as the clock-in kiosk.

## Status

Printing and the API protocol are tested (unit tests + an end-to-end run with a printer emulator). The ZKTeco and
SecuGen adapters are implemented against their published protocols but **have not been tested on physical devices**;
devices remain "unverified" in Chili POS until you test them.
