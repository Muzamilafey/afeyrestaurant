<#
.SYNOPSIS
  Converts a local Windows MongoDB service from standalone to a single-node replica set so Chili POS can use
  transactions. Existing databases are kept as they are — nothing is deleted, dropped or re-created.

.DESCRIPTION
  Dry run by default: it only inspects and prints what it would change. Add -Apply to make the changes.
  With -Apply it:
    1. finds the MongoDB Windows service and the mongod.cfg it starts with;
    2. backs mongod.cfg up next to itself (mongod.cfg.bak-<timestamp>);
    3. adds `replication: replSetName: rs0` only if no replica set is configured yet (an existing name is kept);
    4. if access control (security.authorization: enabled) is on and no keyFile is set, creates a keyfile readable
       only by Administrators, SYSTEM and the service account, and adds security.keyFile (MongoDB requires one for
       replica sets with authorization);
    5. restarts the service — and restores the backup and restarts again if it fails to come up;
    6. runs rs.initiate() ONLY if rs.status() reports NotYetInitialized (an initiated set is never re-initiated),
       waits for the member to become primary and prints rs.hello().

  Requirements: an elevated PowerShell (Run as administrator) for -Apply, and mongosh on PATH (or -Mongosh).
  Works with Windows PowerShell 5.1 and PowerShell 7.

.EXAMPLE
  .\scripts\windows\enable-mongodb-replica-set.ps1                 # dry run: show the current state and the plan
.EXAMPLE
  .\scripts\windows\enable-mongodb-replica-set.ps1 -Apply          # make the change
.EXAMPLE
  .\scripts\windows\enable-mongodb-replica-set.ps1 -Apply -AdminUser admin   # access control enabled (prompts for the password)
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$ServiceName,
  [string]$ConfigPath,
  [string]$ReplSetName = 'rs0',
  [string]$AdminUser,
  [string]$KeyFilePath = (Join-Path $env:ProgramData 'MongoDB\keyfile'),
  [string]$Mongosh = 'mongosh'
)
$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "  $m" }
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Plan($m) { Write-Host "  + $m" -ForegroundColor Green }

# ---------------------------------------------------------------- 1. service and config file
Step 'MongoDB service'
$svc = $null
if (-not $ConfigPath -or $ServiceName) {
  if ($ServiceName) { $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" }
  else { $svc = Get-CimInstance Win32_Service | Where-Object { $_.PathName -match 'mongod(\.exe)?["\s]' } | Select-Object -First 1 }
  if (-not $svc) { throw 'No MongoDB Windows service found. Pass -ServiceName, or -ConfigPath for a mongod you start yourself.' }
  Info "Service      : $($svc.Name) ($($svc.State)), runs as $($svc.StartName)"
  Info "Command line : $($svc.PathName)"
  if (-not $ConfigPath) {
    $m = [regex]::Match($svc.PathName, '(?:--config|-f)\s+(?:"([^"]+)"|(\S+))')
    if (-not $m.Success) { throw 'The service does not start mongod with --config, so there is no mongod.cfg to edit. Pass -ConfigPath.' }
    $ConfigPath = if ($m.Groups[1].Value) { $m.Groups[1].Value } else { $m.Groups[2].Value }
  }
}
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Config file not found: $ConfigPath" }
Info "Config file  : $ConfigPath"

# ---------------------------------------------------------------- 2. inspect mongod.cfg
Step 'Current configuration'
$text = [IO.File]::ReadAllText($ConfigPath)
$nl = if ($text -match "`r`n") { "`r`n" } else { "`n" }
$port = 27017
$pm = [regex]::Match($text, '(?m)^\s+port:\s*(\d+)')
if ($pm.Success) { $port = [int]$pm.Groups[1].Value }
$hasReplBlock = $text -match '(?m)^replication:[ \t]*\r?$'
$existingSet = [regex]::Match($text, '(?m)^\s+replSetName:\s*["'']?([^"''\s#]+)').Groups[1].Value
$authOn = $text -match '(?m)^\s+authorization:\s*["'']?enabled'
$hasKeyFile = $text -match '(?m)^\s+keyFile:'
$hasSecurityBlock = $text -match '(?m)^security:[ \t]*\r?$'
Info "Port                 : $port"
Info "Replica set          : $(if ($existingSet) { $existingSet } else { 'not configured (standalone)' })"
Info "Access control       : $(if ($authOn) { 'enabled' } else { 'disabled' })"
Info "keyFile              : $(if ($hasKeyFile) { 'set' } else { 'not set' })"

# ---------------------------------------------------------------- 3. plan the edits
Step 'Plan'
$new = $text
$changes = 0
if ($existingSet) {
  if ($existingSet -ne $ReplSetName) { Warn "A replica set named '$existingSet' is already configured; keeping it. Use replicaSet=$existingSet in MONGODB_URI." }
  $ReplSetName = $existingSet
  Info 'mongod.cfg already has a replica set name - no change needed.'
} elseif ($hasReplBlock) {
  $new = [regex]::Replace($new, '(?m)^replication:[ \t]*\r?$', "replication:$nl  replSetName: $ReplSetName", 1)
  Plan "add replSetName: $ReplSetName under the existing replication: section"; $changes++
} elseif ($new -match '(?m)^#\s*replication:[ \t]*\r?$') {
  $new = [regex]::Replace($new, '(?m)^#\s*replication:[ \t]*\r?$', "replication:$nl  replSetName: $ReplSetName", 1)
  Plan "replace '#replication:' with replication: replSetName: $ReplSetName"; $changes++
} else {
  $new = $new.TrimEnd() + "$nl${nl}replication:$nl  replSetName: $ReplSetName$nl"
  Plan "append replication: replSetName: $ReplSetName"; $changes++
}
$needKeyFile = $authOn -and -not $hasKeyFile
if ($needKeyFile) {
  if ($hasSecurityBlock) { $new = [regex]::Replace($new, '(?m)^security:[ \t]*\r?$', "security:$nl  keyFile: $KeyFilePath", 1) }
  else { $new = $new.TrimEnd() + "$nl${nl}security:$nl  keyFile: $KeyFilePath$nl" }
  Plan "create keyfile $KeyFilePath (Administrators, SYSTEM and the service account only) and set security.keyFile"; $changes++
}
Plan "restart the service, then rs.initiate() only if rs.status() says NotYetInitialized (member host 127.0.0.1:$port)"
$uriAuth = if ($authOn) { '<user>:<password>@' } else { '' }
$authSrc = if ($authOn) { '&authSource=admin' } else { '' }
Info ''
Info "MONGODB_URI to use afterwards: mongodb://${uriAuth}127.0.0.1:$port/chili_pos?replicaSet=$ReplSetName$authSrc"

if (-not $Apply) {
  Write-Host "`nDry run - nothing was changed. Re-run with -Apply in an elevated PowerShell to make these changes." -ForegroundColor Yellow
  if ($changes -gt 0) { Write-Host "`n--- mongod.cfg after the change ---"; Write-Host $new }
  return
}

# ---------------------------------------------------------------- 4. apply
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as Administrator to use -Apply.' }
if (-not $svc) { throw '-Apply needs the Windows service (omit -ConfigPath or pass -ServiceName) so it can be restarted.' }
if (-not (Get-Command $Mongosh -ErrorAction SilentlyContinue)) { throw "mongosh not found. Install MongoDB Shell (https://www.mongodb.com/try/download/shell) or pass -Mongosh <path to mongosh.exe>." }

$backup = $null
if ($changes -gt 0) {
  Step 'Writing configuration'
  $backup = "$ConfigPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item -LiteralPath $ConfigPath -Destination $backup
  Info "Backup: $backup"
  if ($needKeyFile) {
    New-Item -ItemType Directory -Force -Path (Split-Path $KeyFilePath) | Out-Null
    $bytes = New-Object byte[] 756
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [IO.File]::WriteAllText($KeyFilePath, [Convert]::ToBase64String($bytes))
    & icacls $KeyFilePath /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' "$($svc.StartName):R" | Out-Null
    Info "Keyfile created: $KeyFilePath"
  }
  # UTF-8 without BOM, like the original file.
  [IO.File]::WriteAllText($ConfigPath, $new, (New-Object Text.UTF8Encoding $false))
  Info 'mongod.cfg updated.'
}

function Wait-Port([int]$p, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $p); $c.Close(); return $true } catch { Start-Sleep -Seconds 1 }
  }
  return $false
}

Step "Restarting service $($svc.Name)"
Restart-Service -Name $svc.Name -Force
if (-not (Wait-Port $port 60)) {
  Warn 'MongoDB did not come back up with the new configuration.'
  if ($backup) {
    Copy-Item -LiteralPath $backup -Destination $ConfigPath -Force
    Restart-Service -Name $svc.Name -Force
    Warn "Restored $backup and restarted the service. Check the mongod log (systemLog.path in mongod.cfg) for the reason."
  }
  exit 1
}
Info 'Service is running.'

Step 'Replica set'
$js = @"
let st; try { st = rs.status(); } catch (e) { st = e; }
if (st.ok === 1) { print('Already initiated: set ' + st.set + ' - not re-initiating.'); }
else if (st.codeName === 'NotYetInitialized') { rs.initiate({ _id: '$ReplSetName', members: [{ _id: 0, host: '127.0.0.1:$port' }] }); print('Initiated replica set $ReplSetName.'); }
else { print('rs.status() failed: ' + (st.codeName || st.message)); quit(2); }
for (let i = 0; i < 30 && !db.hello().isWritablePrimary; i++) sleep(1000);
const h = db.hello();
print('rs.hello(): setName=' + h.setName + ' isWritablePrimary=' + h.isWritablePrimary + ' primary=' + h.primary);
quit(h.isWritablePrimary ? 0 : 3);
"@
$tmp = Join-Path $env:TEMP "chili-rs-$PID.js"
[IO.File]::WriteAllText($tmp, $js)
try {
  $shArgs = @("mongodb://127.0.0.1:$port/?directConnection=true", '--quiet', '--file', $tmp)
  if ($AdminUser) { $shArgs += @('--username', $AdminUser, '--authenticationDatabase', 'admin') }  # mongosh prompts for the password
  & $Mongosh @shArgs
  $code = $LASTEXITCODE
} finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
if ($code -ne 0) { Warn "Replica set check failed (exit $code). With access control enabled pass -AdminUser <a user with clusterAdmin or root>."; exit $code }

Write-Host "`nDone. Set MONGODB_URI=mongodb://${uriAuth}127.0.0.1:$port/chili_pos?replicaSet=$ReplSetName$authSrc in server\.env, then run: npm run db:check -w server" -ForegroundColor Green
