# Biometric devices & attendance

## Supported device families

| Family | Connection | Implementation | Status |
|---|---|---|---|
| **ZKTeco** standalone/network terminals (e.g. K40, MB460, SpeedFace) | UDP/TCP 4370 on the LAN, reached by the Chili Bridge | Open-source ZK protocol client (`zkteco-js`): test, clock sync, attendance download, user list, create/delete user | **Unverified** — test each model |
| **SecuGen** USB readers (Hamster Pro 20, etc.) | USB on the bridge PC through the SecuGen **WebAPI** service (SGIBioSrv) | Capture, match, local enrolment, kiosk clock-in page at `http://127.0.0.1:9632/clock` | **Unverified** — requires the SecuGen WebAPI installer and licence |
| Other devices | — | Add an adapter implementing `bridge/src/devices/types.ts` | — |

Devices are registered as **unverified**. Mark a device verified (Staff → Devices) only after physically enrolling
a user and recording punches on that exact model; the note you enter is kept in the audit log.

## How data flows

- **ZKTeco**: fingerprints are enrolled **on the terminal** (User Mgt → user → Fingerprint) and never leave it.
  Chili POS creates the user record on the device (user code = employee's *device user code*) and the bridge downloads
  punches every few minutes (and on *Pull logs*). Punches are de-duplicated by device + user + timestamp, so
  re-downloading is safe. Device clocks are decoded in `DEVICE_TZ` (Africa/Nairobi by default); *Sync clock* sets the
  device time; impossible timestamps are rejected.
- **SecuGen**: templates (ISO 19794-2) are captured on the bridge PC, stored there **encrypted** (`TEMPLATE_KEY`) and
  matched locally. Only clock events reach the cloud.
- The cloud stores **enrolment references** (employee, device, user code, status) — never fingerprint images or
  templates — plus attendance events.
- Device offline/online status is reported by the bridge heartbeat; a device going offline emails the alert contact.

## Attendance features

Clock in/out and breaks, shifts with grace periods, late arrival, early departure, overtime, missing clock-out,
manual corrections (approved by a different person, audited), POS PIN clock-in as a non-biometric alternative,
daily/monthly reports and CSV export (Staff & Attendance).

## Data protection (Kenya Data Protection Act, 2019)

Biometric data is **sensitive personal data**. Before production use:

1. Complete a **Data Protection Impact Assessment** (s.31) and confirm your lawful basis; register with the ODPC as a
   data controller where required.
2. Give staff a written privacy notice; record **informed consent** in Chili POS before enrolment (enforced — enrolment
   is refused without it) and offer the **PIN alternative** to anyone who declines.
3. Withdrawing consent queues deletion of the employee's templates from devices (and the bridge store).
4. Define retention (e.g. delete templates when employment ends) and restrict device admin access.
5. Keep devices and the bridge on a private network segment; do not expose port 4370 to the internet.

This guidance is not legal advice — consult your data protection officer or counsel.
