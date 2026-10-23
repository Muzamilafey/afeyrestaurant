# Several tills, one restaurant, one database

Chili POS is a web application. **There is one server and one database; every till is a client.** Tills never talk to
MongoDB directly — they open the Chili POS address in a browser (or as an installed app), and the server reads and
writes the single database. Orders, tables, kitchen tickets, cash drawers and stock are therefore the same on every
till the moment they change (tills update each other in real time).

```
                         ┌──────────────────────── Server PC (always on) ────────────────────────┐
  Till 1 (counter) ─┐    │  Caddy (HTTPS :443) ──► Chili POS API (:4000) ──► MongoDB (replica set) │
  Till 2 (bar) ─────┼──► │        └─ serves the web app                                           │
  Tablet (waiter) ──┤    │  Chili Bridge (optional) ──► network printers, ZKTeco fingerprint      │
  Kitchen screen ───┘    └────────────────────────────────────────────────────────────────────────┘
          (Wi-Fi / LAN)          ▲ receipt printers 9100 · kitchen/bar printers · ZKTeco 4370
```

> **Shortcut:** steps 2–5 and the certificate/firewall parts are automated by one command on the server PC
> (PowerShell as Administrator, in the project folder):
> `powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1` — it prints the links and the setup
> token when done. Then continue with step 7 on the other tills.

Pick where the server runs:

| | **A. Server PC in the restaurant** (this guide) | **B. Cloud server** ([DEPLOYMENT.md](DEPLOYMENT.md)) |
|---|---|---|
| Works when the internet is down | Yes — everything on the LAN keeps working | Tills switch to offline cash sales until it returns |
| M-Pesa STK push, SMS, email | Need internet; M-Pesa needs a public callback (see step 11) | Work directly |
| Owner sees the dashboard from home | Only with a VPN/tunnel | Yes |
| Multiple branches | One branch per server | Yes |
| You maintain | A PC, its backups and UPS | A VPS |

The rest of this guide is option **A on Windows**, because that is the setup you already have. Option B is the
same for the tills (steps 7–10) — only the server part differs.

---

## Phones can't reach the server? Use Tailscale

If tills or phones show "This site can't be reached" although the server works on the PC itself (common causes:
the router's client/AP isolation, a VPN on the phone, a Wi-Fi extender on another network), run the installer with
`-Tailscale` on the server PC:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -Tailscale
```

It installs Tailscale, signs the PC in (a browser opens — a free account is fine), and publishes Chili POS at a
private address such as `https://afey.your-tailnet.ts.net` with a real certificate. On each phone/tablet: install the
**Tailscale** app, sign in with the **same account**, turn it on, open that address. No router settings, no
certificate to install, and it also works on mobile data (handy for the owner's dashboard). Needs internet; the
local `https://<PC IP>` address keeps working on the LAN.

## 1. Plan the network

Use one router/switch for the restaurant. Give every fixed device a **reserved IP address** (router admin page →
DHCP reservation, by MAC address) so addresses never change. Example plan:

| Device | IP | Notes |
|---|---|---|
| Router | 192.168.1.1 | |
| **Server PC** | **192.168.1.10** | Wired (Ethernet), on a UPS, never sleeps |
| Receipt printer – counter | 192.168.1.21 | Port 9100 |
| Receipt printer – bar | 192.168.1.22 | |
| Kitchen ticket printer | 192.168.1.23 | |
| Bar ticket printer | 192.168.1.24 | |
| ZKTeco fingerprint terminal | 192.168.1.30 | Port 4370 — see [FINGERPRINT-DEVICES.md](FINGERPRINT-DEVICES.md) |
| Tills, tablets, phones | DHCP | Any address on the same network |

Keep tills and devices on a **private** network (a separate Wi-Fi for guests). Never forward ports 4000, 27017, 4370
or 9100 on the router.

## 2. Prepare the server PC

1. Windows 10/11 Pro, at least 8 GB RAM and an SSD. Set **Power & sleep → Never**, turn off automatic restart for
   updates during opening hours (Windows Update → Advanced → Active hours).
2. Install **Node.js 22 LTS** (https://nodejs.org), **Git**, **MongoDB Community Server** (as a Windows service),
   **MongoDB Shell (mongosh)** and the **MongoDB Database Tools** (for backups).
3. Make MongoDB a single-node replica set (required for transactions) — run the helper as Administrator:

```powershell
cd C:\chili-pos   # after step 3 below; or run it from wherever you cloned the project
powershell -ExecutionPolicy Bypass -File .\scripts\windows\enable-mongodb-replica-set.ps1 -Apply
```

   Details and the manual steps are in [MONGODB-WINDOWS.md](MONGODB-WINDOWS.md). MongoDB stays bound to
   `127.0.0.1` — only the API on this PC talks to it.

## 3. Install Chili POS on the server PC

```powershell
git clone https://github.com/muzamilafey/afeyrestaurant.git C:\chili-pos
cd C:\chili-pos
npm ci
npm run build            # builds server\dist, web\dist and bridge\dist
copy server\.env.example server\.env
notepad server\.env
```

Set these in `server\.env`. Generate each secret in PowerShell with
`$b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)` (use `byte[] 32` for `SECRETS_ENCRYPTION_KEY`):

```ini
NODE_ENV=production
PORT=4000
MONGODB_URI=mongodb://127.0.0.1:27017/chili_pos?replicaSet=rs0
# The addresses tills use (step 6). Every address in the browser's address bar must be listed here.
CORS_ORIGINS=https://192.168.1.10,https://pos.afey.lan
PUBLIC_API_URL=https://192.168.1.10
COOKIE_SECURE=true
TRUST_PROXY=loopback
JWT_ACCESS_SECRET=<48+ random characters>
SECRETS_ENCRYPTION_KEY=<32-byte base64 key — back this up, integration secrets cannot be decrypted without it>
RUN_WORKER_IN_PROCESS=true
UPLOAD_DIR=C:\chili-pos\server\uploads
# Only for the first-run screen; remove after setup (or use `npm run setup -w server`)
SETUP_TOKEN=<any long random text>
```

Check the database before going further:

```powershell
npm run db:check         # must end with READY
```

## 4. Run the API as a Windows service

Use **NSSM** (https://nssm.cc, copy `nssm.exe` to `C:\Windows\System32`). In PowerShell **as Administrator**:

```powershell
nssm install ChiliPOS "C:\Program Files\nodejs\node.exe" "C:\chili-pos\server\dist\index.js"
nssm set ChiliPOS AppDirectory C:\chili-pos\server
nssm set ChiliPOS AppStdout C:\chili-pos\logs\api.log
nssm set ChiliPOS AppStderr C:\chili-pos\logs\api.log
nssm set ChiliPOS AppRotateFiles 1
nssm set ChiliPOS AppRotateBytes 10485760
nssm set ChiliPOS DependOnService MongoDB
nssm set ChiliPOS Start SERVICE_AUTO_START
mkdir C:\chili-pos\logs -Force
nssm start ChiliPOS
Invoke-RestMethod http://127.0.0.1:4000/api/v1/ready      # status: ready, transactions: ok
```

`AppDirectory` must be the `server` folder so `.env` is found. With `RUN_WORKER_IN_PROCESS=true` one process also runs
background jobs (SMS/email queue, M-Pesa checks, reminders) — right for a single server PC.

## 5. HTTPS for the tills (Caddy)

Browsers only allow sign-in cookies, offline mode and installing the app over **HTTPS**, so the server needs a
certificate even on a local network. **Caddy** does this with its own local certificate authority.

1. Download `caddy_windows_amd64.zip` from https://caddyserver.com/download, put `caddy.exe` in `C:\caddy`.
2. Copy `C:\chili-pos\deploy\caddy\Caddyfile` to `C:\caddy\Caddyfile` and edit the IP address and name to match
   step 1, and the `root` path if you installed somewhere else.
3. Check it and install it as a service (as Administrator):

```powershell
C:\caddy\caddy.exe validate --config C:\caddy\Caddyfile
nssm install Caddy C:\caddy\caddy.exe run --config C:\caddy\Caddyfile
nssm set Caddy AppDirectory C:\caddy
nssm set Caddy DependOnService ChiliPOS
nssm start Caddy
```

4. Open the firewall for HTTPS on the private network only (the API port 4000 stays closed):

```powershell
New-NetFirewallRule -DisplayName "Chili POS HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443,80 -Action Allow -Profile Private
Get-NetConnectionProfile          # the restaurant network must show NetworkCategory: Private
# if it says Public:  Set-NetConnectionProfile -InterfaceAlias "Ethernet" -NetworkCategory Private
```

5. Export Caddy's root certificate so the tills can trust it (Caddy creates it on first start). When Caddy runs as a
   service under the SYSTEM account it is here:

```powershell
copy "C:\Windows\System32\config\systemprofile\AppData\Roaming\Caddy\pki\authorities\local\root.crt" C:\chili-pos\chili-root.crt
```

   Copy `chili-root.crt` to a USB stick (it is a public certificate — safe to copy; never copy the `.key` file next
   to it).

## 6. Choose the address tills will use

The simplest is the IP: **https://192.168.1.10**. To use a name such as **https://pos.afey.lan**, either add a DNS
entry on the router, or on each Windows till add this line to `C:\Windows\System32\drivers\etc\hosts`
(Notepad as Administrator):

```
192.168.1.10   pos.afey.lan
```

Whatever you choose must be listed in `CORS_ORIGINS` (step 3) and in the Caddyfile (step 5). Restart both services
after changing them: `nssm restart ChiliPOS; nssm restart Caddy`.

## 7. Set up each till

Do this on every till PC, tablet or phone.

**Trust the certificate (once per device)**

- Windows: double-click `chili-root.crt` → *Install Certificate* → *Local Machine* → *Place all certificates in the
  following store* → **Trusted Root Certification Authorities**. Or, as Administrator:
  `Import-Certificate -FilePath E:\chili-root.crt -CertStoreLocation Cert:\LocalMachine\Root`
- Android: copy the file to the tablet → Settings → Security → *Encryption & credentials* → *Install a certificate*
  → **CA certificate**.
- iPad/iPhone: AirDrop/email the file → Settings → *Profile Downloaded* → Install → then Settings → General → About →
  *Certificate Trust Settings* → turn on full trust for it.

**Open and install the app**

1. Open **Microsoft Edge** or **Chrome** at `https://192.168.1.10`. There must be no certificate warning — if there
   is, the certificate step was missed.
2. Install it: Edge ⋯ → *Apps* → *Install this site as an app* (Chrome: ⋮ → *Cast, save and share* → *Install*); on tablets
   ⋮ → *Add to Home screen*. The installed app opens full screen, starts offline and is named after your business.
3. Optional — dedicated till that always opens the POS full screen (Windows): create a shortcut with
   `"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk https://192.168.1.10/pos --edge-kiosk-type=fullscreen`
   and put it in `shell:startup`.

**First time only (on any one till):** complete the first-run setup screen (business, first branch, owner), using the
`SETUP_TOKEN` from step 3. Then remove `SETUP_TOKEN` from `server\.env` and `nssm restart ChiliPOS`.

**Make it a till (each device)**

1. Sign in once with a **manager or owner** email and password.
2. Account menu (your name, bottom left) → **PIN sign-in on this device** → name it (`Counter till`, `Bar till`,
   `Waiter tablet 1`) → **Use this device**.
3. Same menu → **Receipt printer for this till** → choose the printer next to this till (after step 8). Tablets
   without a printer can keep *Automatic*.
4. Sign out. From now on staff tap their name and enter their PIN on this till.

## 8. Printers and the bridge

Network printers and the ZKTeco terminal are driven by the **Chili Bridge**. One bridge on the server PC can drive
every network printer and terminal on the LAN.

1. Integrations → **Local bridges → Register bridge** → name it `Server PC` → copy the token (shown once).
2. On the server PC:

```powershell
cd C:\chili-pos\bridge
copy .env.example .env
notepad .env
```

```ini
# The bridge runs on the server PC, so it talks to the API directly (no certificate needed)
CHILI_API_URL=http://127.0.0.1:4000
CHILI_BRIDGE_TOKEN=cbr_...the token from step 1...
ALLOWED_ORIGINS=https://192.168.1.10,https://pos.afey.lan
LOCAL_TOKEN=<any random text>
DEVICE_TZ=Africa/Nairobi
```

```powershell
nssm install ChiliBridge "C:\Program Files\nodejs\node.exe" "C:\chili-pos\bridge\dist\index.js"
nssm set ChiliBridge AppDirectory C:\chili-pos\bridge
nssm set ChiliBridge DependOnService ChiliPOS
nssm start ChiliBridge
```

   If a bridge runs on **another PC** (for example a till with a USB fingerprint reader), set
   `CHILI_API_URL=https://192.168.1.10` and tell Node.js to trust Caddy's certificate:
   `nssm set ChiliBridge AppEnvironmentExtra NODE_EXTRA_CA_CERTS=C:\chili-pos\chili-root.crt`.

3. Integrations → **Printers → Add** for each printer: name, role (*Receipts*, *Bills*, *Kitchen tickets*,
   *Bar tickets*), connection *Network*, IP and port 9100, paper width 80 or 58 mm, bridge `Server PC`. Press
   **Test print**.
4. Kitchen and bar tickets go automatically to the printers with those roles. Receipts go to the printer chosen on
   each till (step 7.3), otherwise to the first *Receipts* printer, otherwise the browser print dialog.
5. Cash drawers plug into the receipt printer's drawer (DK/RJ11) port and open with the receipt.

## 9. Cash drawers: one per till or one shared

Settings → Branches → edit the branch → **Cash drawer**:

- **Separate drawer for each user** — each cashier opens their own drawer with a float and counts it at the end of
  the shift. Best when several cashiers each have their own cash tray.
- **One shared drawer for everyone** — one person opens it; cash taken on any till goes into it; it is counted and
  closed once. Best for one cash box shared by all tills.

The mode can only be changed when every drawer in the branch is closed.

## 10. Kitchen and bar screens

Any extra screen (a TV with a mini PC, or a tablet) can be a kitchen display: do step 7, sign in as the chef or
bartender, open **Kitchen Orders** or **Bar Orders**. New orders appear within a second; tickets disappear when the
order is served or paid.

## 11. Internet services from a local server

The tills and the database work without internet. These need internet on the server PC:

- **SMS (Talk Sasa) and email**: just need outbound internet. Messages queue and send when it returns.
- **M-Pesa STK push**: Safaricom must reach a **public HTTPS callback URL**, which a local IP is not. Options:
  run a tunnel (e.g. Cloudflare Tunnel) for `/api/v1/mpesa/*` only and set `PUBLIC_API_URL` to the tunnel address;
  or rely on Chili POS asking Safaricom for the payment status (automatic, about every 30 seconds after the prompt
  expires — slower to confirm);
  or use option B (cloud) if M-Pesa is your main payment method. Till-number (C2B) payments can always be matched
  manually under the order with the M-Pesa code.

## 12. Backups (server PC)

Create `C:\chili-pos\backup.ps1`:

```powershell
$dir = "D:\chili-backups"; New-Item -ItemType Directory -Force $dir | Out-Null
$file = Join-Path $dir ("chili-pos-{0}.archive.gz" -f (Get-Date -Format yyyyMMdd-HHmm))
& "C:\Program Files\MongoDB\Tools\100\bin\mongodump.exe" --uri="mongodb://127.0.0.1:27017/chili_pos?replicaSet=rs0" --gzip --archive="$file"
if ($LASTEXITCODE -ne 0) { throw "Backup failed" }
Get-ChildItem $dir -Filter *.archive.gz | Where-Object LastWriteTime -lt (Get-Date).AddDays(-14) | Remove-Item
```

Schedule it nightly (as Administrator):

```powershell
$a = New-ScheduledTaskAction -Execute powershell.exe -Argument "-ExecutionPolicy Bypass -File C:\chili-pos\backup.ps1"
$t = New-ScheduledTaskTrigger -Daily -At 3am
Register-ScheduledTask -TaskName "Chili POS backup" -Action $a -Trigger $t -User SYSTEM -RunLevel Highest
```

Copy the backups off the PC every week (USB drive or cloud storage), and keep a copy of `server\.env` somewhere safe.
Restore with `mongorestore --uri=... --gzip --archive=<file>` into a **new** database name first to test it.

## 13. Updating

```powershell
cd C:\chili-pos
git pull
npm ci
npm run build
nssm restart ChiliPOS; nssm restart ChiliBridge
```

Tills show **"A new version is ready — Update now"**; staff press it between orders.

## 14. Check list

- [ ] `npm run db:check` → READY; `https://192.168.1.10/api/v1/ready` → `ready`
- [ ] Every till opens `https://192.168.1.10` **without** a certificate warning and shows *Online*
- [ ] An order placed on Till 1 appears on Till 2's order board and the kitchen screen within a second
- [ ] Each till prints its receipt on its own printer; kitchen/bar tickets print at the stations
- [ ] Pull the server PC's network cable: tills show *Offline*; reconnect → offline sales sync
- [ ] A backup file appears the next morning and restores into a test database

## Troubleshooting

| Symptom | Fix |
|---|---|
| Certificate warning on a till | Install `chili-root.crt` into *Trusted Root* (step 7); the address must match the Caddyfile |
| Sign-in works on the server PC but not on tills | Add the exact address from the till's address bar to `CORS_ORIGINS`, restart ChiliPOS |
| Till can't reach the server | Same network? `Test-NetConnection 192.168.1.10 -Port 443` from the till; firewall profile *Private* (step 5) |
| Orders don't appear on other tills until refresh | Realtime runs over `/api/v1/realtime` — make sure Caddy proxies `/api/*` (default Caddyfile does) |
| Prints don't come out | Integrations → Printers → *Test print*; bridge status *online*; ping the printer IP |
| `ReplicaSetNoPrimary` / 503 *database not ready* | [MONGODB-WINDOWS.md](MONGODB-WINDOWS.md) |
