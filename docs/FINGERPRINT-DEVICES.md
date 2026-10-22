# Fingerprint devices: step-by-step setup

Chili POS supports two kinds of fingerprint hardware for staff attendance (clock in/out, breaks):

| | **ZKTeco terminal** (K40, MB160/MB460, SpeedFace, UFace…) | **SecuGen USB reader** (Hamster Pro 20 / Hamster Plus) |
|---|---|---|
| Looks like | Wall-mounted clock with its own screen and keypad | Small USB reader plugged into a PC |
| Fingerprints are stored | On the terminal | Encrypted on the PC it is plugged into |
| Staff clock in on | The terminal itself | A full-screen "clock-in" page on that PC |
| Needs | Network cable/Wi-Fi + the Chili Bridge on any PC on the LAN | The Chili Bridge **on the same PC** + SecuGen WebAPI |

Fingerprint images and templates **never go to the Chili POS server or database** — only "employee X clocked in at
08:02 on device Y". How the data flows and the data-protection rules are in [integrations/biometrics.md](integrations/biometrics.md).

> **Status:** both adapters are written against the vendors' published protocols but have not yet been tested on
> physical hardware. Every device starts as **Unverified**; do the physical test in step 6 and only then mark it
> verified.

## Before you start (both types)

1. **The Chili Bridge is running** on a PC on the restaurant network, and shows *online* under Integrations →
   Local bridges. Setup: [MULTI-TILL.md, step 8](MULTI-TILL.md#8-printers-and-the-bridge) or [bridge/README.md](../bridge/README.md).
2. **Legal (Kenya Data Protection Act, 2019):** fingerprints are sensitive personal data. Give staff the written
   privacy notice; record each person's consent in Chili POS before enrolling (the system refuses to enrol without
   it); anyone who declines clocks in with their POS PIN instead. See [integrations/biometrics.md](integrations/biometrics.md).
3. **Employees exist** in Staff & Attendance → **Employees** (name, employee no., job title).

---

## Part A — ZKTeco network terminal

### A1. Connect and address the terminal

1. Mount the terminal near the staff entrance, connect it to the restaurant network with a cable (preferred) or Wi-Fi.
2. On the terminal: **Menu → Comm. (Communication) → Ethernet** (on some models *Network* or *TCP/IP*):
   - **DHCP: Off**
   - **IP address:** e.g. `192.168.1.30` (also reserve it on the router)
   - **Subnet mask:** `255.255.255.0`
   - **Gateway:** `192.168.1.1` (your router)
3. **Menu → Comm. → PC Connection** (or *Cloud/Connection*):
   - **Comm Key / Password: `0`** — Chili POS connects without a communication password.
   - **Device ID: 1**
   - **Port: 4370** (default — leave it)
4. **Menu → System → Date/Time:** set the time zone to Nairobi (UTC+3). Chili POS will keep the clock in sync.
5. Restart the terminal (Menu → System → Reboot, or power off/on).

### A2. Check the PC with the bridge can reach it

On the PC running the bridge (PowerShell):

```powershell
Test-NetConnection 192.168.1.30 -Port 4370      # TcpTestSucceeded : True
```

If it fails: check the cable/Wi-Fi, that both are on `192.168.1.x`, and that no firewall on the PC blocks outbound
connections. (UDP-only firmware may report False here but still work — continue to A3 and use **Test**.)

### A3. Register the terminal in Chili POS

Staff & Attendance → **Devices** → **Register device**:

| Field | Value |
|---|---|
| Name | `Staff entrance` |
| Type | **ZKTeco network terminal** |
| Model | e.g. `K40` (as printed on the device) |
| LAN IP | `192.168.1.30` |
| Port | `4370` |
| Bridge | the bridge that can reach it (e.g. `Server PC`) |

Save, then on the device's row:

1. **Test** — the device should report *online* (the bridge reads its serial number, name and clock).
2. **Sync clock** — sets the terminal's time from the server. Do this if the clock is out by more than a minute.

### A4. Enrol staff

For each employee:

1. Staff & Attendance → **Employees** → **Edit** → set **Device user code** — a number unique per person, e.g. the
   employee number `1001`. This is the ID the terminal uses.
2. **Record consent** (after they read and accepted the privacy notice).
3. **Enrol** → choose the ZKTeco terminal. Chili POS creates user `1001` with the employee's name on the terminal
   (sent through the bridge within a few seconds).
4. **On the terminal:** Menu → **User Mgt** → find user `1001` → **Edit** → **Fingerprint** → the employee places the
   same finger **three times**. Enrol a second finger as a backup. Press OK/Save.

> Already-enrolled terminals: if staff were enrolled on the terminal before, just set each employee's **Device user
> code** to the user ID they already have on the terminal — no re-enrolment needed.

### A5. Daily use

- Staff press their finger on the terminal. The terminal's punch-state keys (*Check-In*, *Check-Out*, *Break Out*,
  *Break In*, *OT-In*, *OT-Out*) decide which kind of punch is recorded — set the default state on the terminal
  (Menu → *Punch State* / *Attendance Status*) or ask staff to press the key before scanning.
- The bridge downloads punches **every 5 minutes** (`ATTENDANCE_PULL_MINUTES` in the bridge `.env`), or press
  **Pull logs** on the device row. Re-downloading never creates duplicates.
- See them under Staff & Attendance → **Clock events** and the **Attendance report** (late, early, overtime,
  missing clock-out; CSV export).
- If the terminal goes offline, the device row shows it (and the alert contact in Settings is emailed); punches are
  kept on the terminal and downloaded when it is back.

### A6. Physical test, then mark verified

Enrol one person, punch in and out, **Pull logs**, check the two events appear with the right times. Then on the
device row → **Mark verified** and describe the test (model, firmware, what you checked). The note is audit-logged.

---

## Part B — SecuGen USB reader on a PC

The reader plugs into a PC (often a till or a small PC at the staff entrance). **That PC must run the Chili Bridge**,
because the fingerprint templates are stored and matched there.

### B1. Install the SecuGen software on that PC

1. Plug in the reader and install the **SecuGen USB device driver** for your model (https://secugen.com/drivers).
   Windows Device Manager should list it under *Biometric devices*.
2. Install **SecuGen WebAPI Client** (*SgiBioSrv*) from https://webapi.secugen.com. It runs as a Windows service on
   `https://localhost:8443`.
3. Check it: on that PC open SecuGen's WebAPI demo page (https://webapi.secugen.com → *Demo*) and capture a
   fingerprint — if it captures, the service and driver work. If your WebAPI edition needs a licence string, keep it
   for B2.

### B2. Configure the bridge on that PC

In `bridge\.env` on that PC (see [MULTI-TILL.md, step 8](MULTI-TILL.md#8-printers-and-the-bridge) for installing a
bridge on a PC other than the server):

```ini
SECUGEN_WEBAPI_URL=https://localhost:8443
SECUGEN_LICENSE=            # only if SecuGen gave you a licence string
# Encrypts the fingerprint templates stored on this PC. Generate once and keep a copy somewhere safe:
#   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
TEMPLATE_KEY=<32-byte base64 key>
LOCAL_PORT=9632
```

Restart the bridge (`nssm restart ChiliBridge`). Templates are saved encrypted in `bridge\data\templates.enc` on this
PC only. **If `TEMPLATE_KEY` is lost, everyone must be re-enrolled** — back it up.

### B3. Register the reader in Chili POS

Staff & Attendance → **Devices** → **Register device**: Name `Back office reader`,
Type **SecuGen USB reader (via bridge)**, Model `Hamster Pro 20`, Bridge = **the bridge on the PC the reader is plugged into**. Save → **Test** (reports the
reader through the WebAPI).

### B4. Enrol staff

1. Employees → **Record consent** for the employee.
2. **Enrol** → choose the SecuGen reader.
3. At that PC, the employee places their finger on the reader when it lights up (within about 10 seconds). Enrolment
   is confirmed in Chili POS; repeat for a second finger if you like.

### B5. The clock-in kiosk

On the PC with the reader, open **`http://127.0.0.1:9632/clock`** — a full-screen page where staff touch the reader to
clock in or out. To open it automatically, full screen, on startup:

```
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk http://127.0.0.1:9632/clock --edge-kiosk-type=fullscreen
```

(put the shortcut in `shell:startup`). The page only works on that PC — the bridge listens on `127.0.0.1`.

### B6. Physical test, then mark verified

Enrol one person, clock in and out on the kiosk, check Clock events, then **Mark verified** with a short description.

---

## Removing someone

When an employee leaves or withdraws consent: Employees → **Withdraw consent**. Chili POS queues deletion of their
user/templates from the terminal or the bridge store. Check on a ZKTeco terminal under
User Mgt that the user is gone.

## Troubleshooting

| Problem | Check |
|---|---|
| ZKTeco **Test** fails / *offline* | Ping the IP from the bridge PC; Comm Key is `0`; port 4370; device and PC on the same network; the right bridge is selected on the device |
| Punch times are 3 hours off | Set `DEVICE_TZ=Africa/Nairobi` in the bridge `.env` and the terminal's time zone; press **Sync clock** |
| Punches missing | Press **Pull logs**; the employee's **Device user code** must equal their user ID on the terminal |
| SecuGen **Test** fails | Does SecuGen's WebAPI demo capture on that PC? Driver installed? *SgiBioSrv* service running? The device is assigned to the bridge on *that* PC |
| *Enrolment refused — consent required* | Record consent first (Employees → Record consent) |
| Kiosk page doesn't load | It only works on the PC running the bridge: `http://127.0.0.1:9632/clock`; is the bridge service running? |
| Staff without fingerprints (worn prints, declined) | They clock in with their POS PIN on any till |
