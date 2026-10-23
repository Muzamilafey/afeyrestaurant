# Hosting online, selling offline

Run Chili POS on a cloud server so every till, phone and the owner at home use the same address
(`https://pos.yourrestaurant.co.ke`). When the restaurant's internet drops, the tills keep selling. Each sale is
stored on the till and uploaded on its own when the connection comes back.

```
   Restaurant (Wi-Fi / mobile data)                         Cloud server (VPS)
   Till 1 ─┐                                       ┌──────────────────────────────────────────┐
   Till 2 ─┼── internet ──► https://pos.domain ──► │ Caddy (HTTPS, Let's Encrypt)             │
   Phones ─┤                                       │   └► Chili POS API :4000 ─► MongoDB rs0  │
   Bridge ─┘ (printers, fingerprint devices)       └──────────────────────────────────────────┘
   Owner at home ─────────────► same address
```

## 1. Get a server and a domain

- **A VPS running Ubuntu 22.04 or 24.04 (Debian 12 also works).** It needs 2 GB RAM, 1–2 vCPU and 25 GB disk.
  Hetzner, DigitalOcean, Contabo, AWS Lightsail and Truehost all work. Pick a region close to Kenya if one is
  offered.
- **A domain or sub-domain**, e.g. `pos.myrestaurant.co.ke`. At your domain registrar, create a **DNS A record**
  pointing it to the server's public IP address. Wait until `ping pos.myrestaurant.co.ke` shows that IP; this
  usually takes minutes, sometimes up to an hour.

## 2. One command

SSH into the server, then run:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/muzamilafey/afeyrestaurant.git /tmp/chili && \
sudo bash /tmp/chili/scripts/linux/install.sh --domain pos.myrestaurant.co.ke --email you@myrestaurant.co.ke
```

It checks the server, then sets up the following:

| What | How |
|------|-----|
| Node.js 22, MongoDB 8, Caddy | Official package repositories. Anything already installed is kept. |
| MongoDB | Replica set `rs0`, which sales need for transactions. Listens on the server only (127.0.0.1); existing data is kept. |
| The app | Built in `/opt/chili-pos` and run as the `chili` user by the `chili-pos` systemd service. It restarts on failure and on reboot. |
| Settings | `/etc/chili-pos/chili.env` holds secrets generated once and kept on re-runs. **Back this file up.** |
| HTTPS | Caddy obtains and renews a Let's Encrypt certificate automatically, so there is nothing to install on phones. |
| Firewall | `ufw` allows only SSH, 80 and 443. MongoDB and port 4000 are not reachable from outside. |
| Backups | Nightly at 03:00 to `/var/backups/chili-pos`, keeping 14 days. |

At the end it prints the link and the **first-run setup token**. Open the link, enter the token and create the owner
account.

Options:

- `--update` pulls the latest code, rebuilds and restarts.
- `--dry-run` only shows what it would do.
- `--no-firewall` leaves `ufw` alone.
- `--branch` and `--repo` install from somewhere else.

Update later with:

```bash
sudo bash /opt/chili-pos/scripts/linux/install.sh --domain pos.myrestaurant.co.ke --email you@myrestaurant.co.ke --update
```

## 3. Set up each till and phone

1. Open `https://pos.myrestaurant.co.ke` in Chrome or Edge and sign in.
2. Install it as an app: in the browser menu choose **Install Chili POS** (on Android, **Add to Home screen**). It
   opens full-screen with your business logo.
3. Sign in on every till **while online** at least once. After that the till has the menu, prices and app cached, so
   it can sell offline.

## 4. What happens when the internet drops

The top bar shows **Offline** within about 10 seconds. The till checks the server itself, so it also notices a
connected Wi-Fi with no internet.

- **Selling continues.** Build the order as usual and press **Pay (offline)**. If the connection drops just as you
  press Pay, the offline payment window opens on its own.
- **Payment methods:**
  - **Cash:** enter the cash given and the till shows the change.
  - **Card:** use the card machine as usual (it has its own SIM). You can optionally type the approval code.
  - **M-Pesa:** the customer pays to your Till or Paybill number, and the cashier types the **code from the
    customer's SMS** (e.g. `SJK8H2LQ1P`). STK push needs the server, so it is not offered offline.
- **Printing:** the receipt (marked *OFFLINE SALE*) and the **kitchen/bar tickets** print on the till's printer.
  The kitchen screen cannot receive orders while the restaurant is offline.
- **When the internet returns**, the till uploads the stored sales automatically and shows "N offline sales
  uploaded". The top bar shows how many sales are still waiting. Uploading is safe to repeat: a sale is never
  recorded twice.
- **M-Pesa codes are checked** against the payments Safaricom sends to the server.
  - A code is confirmed automatically when a payment with that code and at least that amount arrived.
  - Codes that are not confirmed, or that were already used on another sale, appear on the owner's **Dashboard**
    under *Offline M-Pesa to confirm*. Check them against the M-Pesa statement.

Admins choose which offline actions are allowed in **Settings → Business → Allowed offline actions** (browse
the menu, take orders, cash, card, M-Pesa code, print receipts).

### Limits while offline

- **Signing in needs the server.** A till that is already signed in keeps working. Don't sign out while offline.
- **Orders already open on the server**, such as a table started before the outage, are paid once the connection
  is back. New sales work offline.
- Stock, reports and the dashboard update when the stored sales are uploaded.
- Each till keeps its own offline sales. Don't clear the browser data on a till that still shows sales waiting to
  upload.

## 5. Printers and fingerprint devices

Those devices are on the restaurant network and the server is in the cloud, so run the **Chili Bridge** on one PC
in the restaurant:

1. In the app, go to **Integrations → Local bridges → Register bridge** and copy the token.
2. On the restaurant PC, set `CHILI_API_URL=https://pos.myrestaurant.co.ke` and `CHILI_BRIDGE_TOKEN=<token>`, then
   start the bridge.

See [bridge/README.md](../bridge/README.md) and [FINGERPRINT-DEVICES.md](FINGERPRINT-DEVICES.md). Fingerprint
devices store punches themselves while the internet is down, and the bridge uploads them later.

## 6. M-Pesa callbacks

The server has a real HTTPS address, so Safaricom can reach it. In **Integrations → M-Pesa**, the callback and C2B
confirmation URLs use `https://pos.myrestaurant.co.ke/api/v1/...`. Offline M-Pesa codes need C2B confirmations to
be registered: see [integrations/mpesa.md](integrations/mpesa.md).

## 7. Looking after the server

- **Logs:** `journalctl -u chili-pos -f` (app) and `journalctl -u caddy -n 50` (HTTPS).
- **Status:** `systemctl status chili-pos mongod caddy`.
- **Backups:** the latest backup time is shown in Settings → Business. Regularly copy `/var/backups/chili-pos` and
  `/etc/chili-pos/chili.env` off the server, for example with your VPS provider's snapshots or
  `rsync`/`scp` to another machine.
- **Restore:** see [DEPLOYMENT.md](DEPLOYMENT.md#backups).

## 8. Or: tills on a restaurant server, with a live copy online

You can also keep the server **inside the restaurant**, a Windows PC installed with
`scripts/windows/install.ps1` (see [MULTI-TILL.md](MULTI-TILL.md)), and link it to a live server on the internet:

```
  Tills ──► Restaurant server (Windows PC, MongoDB) ──── internet ────► Live server (VPS, view only)
            sells with or without internet          sends every change          owner follows from anywhere
```

- The tills only use the restaurant server, so selling never depends on the internet.
- Every change (sales, orders, payments, stock, menu, staff, settings, images) is sent to the live server within
  about 15 seconds.
- When the internet is down, the changes wait on the restaurant server and go out when it comes back. Records
  deleted in the meantime are removed from the live copy too.
- The live server is a **view-only copy**:
  - Sign in there with the same email and password as at the restaurant.
  - It shows the dashboard, sales, orders and reports.
  - Any change is refused with "make changes on the restaurant's own server".
  - It sends no SMS, alerts or summaries itself; the restaurant server does.
- Not copied: sign-in sessions, till registrations, print and message queues, and integration passwords (M-Pesa,
  SMS, email), which stay encrypted on the restaurant server.

**Link them:**

1. Install the live server with the one command from section 2, and **don't** complete the setup screen there. Note
   the **setup token** printed at the end. It is also in `/etc/chili-pos/chili.env` as `SETUP_TOKEN`.
2. On the restaurant server, sign in as the owner. Go to **Settings → Live server**, enter the live address
   (`https://pos.myrestaurant.co.ke`) and the setup token, and press **Connect and start syncing**.
3. The first copy takes a few seconds to a few minutes. The same screen shows the last sync, the number of changes
   waiting and any connection problem. **Sync now** sends immediately and checks everything; **Disconnect** stops
   sending, and the live server keeps what it already has.

If the live server was already set up as a separate business with no sales yet, the restaurant server asks whether
to replace it. A live server that already has its own sales is never overwritten; use a fresh one.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| The link doesn't open after the install | The DNS A record must point at this server (`dig +short pos.domain`). Ports 80 and 443 must be open at the VPS provider's firewall too. `journalctl -u caddy -n 50` |
| "Offline" stays on although the internet works | `systemctl status chili-pos`. Then `curl -s https://pos.domain/api/v1/health` |
| Sales stay "pending sync" | Open the app while online and sign in again if asked. Rejected sales show an error message with the reason. |
| Settings → Live server shows "Waiting for the internet" | The restaurant has no internet, or the live server is down (`systemctl status chili-pos` there). Changes are kept and sent later. |
| "Wrong setup token" or "no longer linked" | Use `SETUP_TOKEN` from `/etc/chili-pos/chili.env` on the live server and connect again. Nothing is lost: everything is sent again. |
| An offline M-Pesa sale is not confirmed | C2B confirmation URL registered? Was the code typed correctly? See Dashboard → *Offline M-Pesa to confirm*. |
