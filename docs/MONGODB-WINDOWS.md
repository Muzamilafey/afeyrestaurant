# MongoDB on Windows: enable transactions (single-node replica set)

Chili POS writes first-run setup, payments, stock movements, cash-up and offline sync in **MongoDB transactions**.
Transactions only work on a **replica set** (or a sharded cluster). A plain standalone `mongod` (which is what the
Windows MSI installs by default) rejects them:

| What you see | Meaning |
|---|---|
| `MongoServerError: Transaction numbers are only allowed on a replica set member or mongos` (code 20, IllegalOperation), setup returns 503 `DATABASE_TRANSACTIONS_UNAVAILABLE` | mongod is **standalone** and `MONGODB_URI` has no `replicaSet=` option, so the connection works but transactions don't. |
| `MongooseServerSelectionError … ReplicaSetNoPrimary` (with `setName: rs0` in the details) at start-up | `MONGODB_URI` contains `?replicaSet=rs0` but the server is standalone, the set was never initiated, or the member's host name in `rs.conf()` is unreachable. |

A **single-node replica set** fixes both. Converting keeps every existing database and document — nothing is
deleted or re-created. Docker is not needed.

## 0. Check what you have

From the project folder (PowerShell):

```powershell
npm run db:check
```

It prints the connection string with the password masked, the deployment type (`standalone` / `replicaSet`), whether
a test transaction works (the probe is always rolled back) and the setup state. Exit code 0 means ready.

If your `MONGODB_URI` points at **MongoDB Atlas** (`mongodb+srv://…`) or a remote VPS, do not run the commands below on
your PC: Atlas clusters are always replica sets (check the URI, user and network access list instead), and a VPS needs
the Linux steps in [SETUP.md](SETUP.md) on that server.

## 1. Automatic (recommended)

Open **PowerShell as Administrator** in the project folder:

```powershell
# Dry run: shows the service, mongod.cfg, current state and exactly what would change. Changes nothing.
powershell -ExecutionPolicy Bypass -File .\scripts\windows\enable-mongodb-replica-set.ps1

# Apply. Backs up mongod.cfg, adds replication.replSetName, restarts the service,
# runs rs.initiate() only if the set is not initiated yet, and prints rs.hello().
powershell -ExecutionPolicy Bypass -File .\scripts\windows\enable-mongodb-replica-set.ps1 -Apply

# If access control is enabled (security.authorization: enabled) - prompts for the password:
powershell -ExecutionPolicy Bypass -File .\scripts\windows\enable-mongodb-replica-set.ps1 -Apply -AdminUser admin
```

Requires [MongoDB Shell (mongosh)](https://www.mongodb.com/try/download/shell) on `PATH`. If the service does not come
back up with the new configuration, the script restores the backup and restarts the service.

## 2. Manual

**a. Find the service and its config file**

```powershell
Get-CimInstance Win32_Service | Where-Object PathName -match 'mongod' | Select-Object Name, State, StartName, PathName
```

The service is usually called `MongoDB`. `PathName` shows the config file after `--config`, typically
`C:\Program Files\MongoDB\Server\<version>\bin\mongod.cfg`.

**b. Back up and edit `mongod.cfg`** (Notepad as Administrator)

```powershell
$cfg = 'C:\Program Files\MongoDB\Server\8.0\bin\mongod.cfg'   # use the path from step a
Copy-Item $cfg "$cfg.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
notepad $cfg
```

Replace the line `#replication:` with (two-space indent, no tabs):

```yaml
replication:
  replSetName: rs0
```

If a `replication:` section with a `replSetName` already exists, leave it as it is and use that name in the URI.
Keep `storage.dbPath` unchanged — that is where your data lives.

**Only if access control is enabled** (`security:` → `authorization: enabled`): replica sets with authorization also
need a keyfile. Create one and add `keyFile` under `security:`:

```powershell
New-Item -ItemType Directory -Force C:\ProgramData\MongoDB | Out-Null
$b = New-Object byte[] 756; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
[IO.File]::WriteAllText('C:\ProgramData\MongoDB\keyfile', [Convert]::ToBase64String($b))
icacls C:\ProgramData\MongoDB\keyfile /inheritance:r /grant:r "Administrators:F" "SYSTEM:F" "NT AUTHORITY\NetworkService:R"
```

```yaml
security:
  authorization: enabled
  keyFile: C:\ProgramData\MongoDB\keyfile
```

(Use the account from `StartName` in step a if the service does not run as NetworkService.)

**c. Restart the service**

```powershell
Restart-Service MongoDB
Get-Service MongoDB          # must be Running; if not, read the log at systemLog.path in mongod.cfg
```

**d. Initiate the replica set — only once, only if it is not initiated yet**

```powershell
mongosh "mongodb://127.0.0.1:27017/?directConnection=true"
```

```js
rs.status()     // "NotYetInitialized" → run the next line. ok: 1 → already initiated, do NOT run it.
rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] })
rs.hello()      // wait a few seconds: setName: 'rs0', isWritablePrimary: true
```

(With access control add `-u admin --authenticationDatabase admin` to the mongosh command.)
Using `127.0.0.1` as the member host avoids the classic `ReplicaSetNoPrimary` problem where the member is registered
under the PC's name and the driver cannot resolve it.

## 3. Point Chili POS at the replica set

In `server\.env` (development) set:

```
MONGODB_URI=mongodb://127.0.0.1:27017/chili_pos?replicaSet=rs0
# with access control:
# MONGODB_URI=mongodb://chili:<password>@127.0.0.1:27017/chili_pos?replicaSet=rs0&authSource=admin
```

Keep development and production apart: use a different database name (e.g. `chili_pos_dev`) or server for
development, and configure production through the production server's own environment — never copy the dev `.env`.

## 4. Verify

```powershell
npm run db:check                  # READY, deployment replicaSet (set "rs0"), transactions ok
npm run dev:server                # log: "MongoDB connected" with deployment: replicaSet, transactions: true
Invoke-RestMethod http://localhost:4000/api/v1/ready   # status ready, database ok, transactions ok
```

Then open the web app (`npm run dev:web`, http://localhost:5173), complete first-run setup and sign in.
Submitting setup again answers **409 ALREADY_SET_UP** and changes nothing.

## How Chili POS behaves without transactions

- **Production** (`NODE_ENV=production`): the API refuses to start and logs why.
- **Development**: the API starts (so you can see the screens) but logs an error with these instructions, `/ready`
  answers 503, and every operation that needs a transaction answers **503 `DATABASE_TRANSACTIONS_UNAVAILABLE`**
  *before writing anything*. There is no silent fallback to non-transactional writes.
- Error responses never contain driver messages or stack traces; the server log has the details, matched by the
  `requestId` in the response.
