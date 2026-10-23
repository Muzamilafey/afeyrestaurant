<#
.SYNOPSIS
  One-command install of Chili POS on a Windows PC for local (restaurant network) use.

.DESCRIPTION
  Run once in an elevated PowerShell (Run as administrator). It:
    1. checks this PC (Windows, PowerShell, winget, administrator, disk space, ports 4000/443/80) and every tool it
       needs - Node.js 20+, npm, Git, MongoDB Server 5.0+, mongosh, MongoDB Database Tools, NSSM, Caddy - showing the
       version found, then installs or upgrades only what is missing or too old (with winget) and checks again;
    2. converts MongoDB to a single-node replica set (keeps all data; never re-initiates an existing set);
    3. gets the code (uses the folder this script is in, or clones it), runs `npm ci` and `npm run build`;
    4. creates production settings with generated secrets (stored in C:\ProgramData\ChiliPOS, reused on every
       re-run - never regenerated) without changing an existing server\.env;
    5. runs the backend (ChiliPOS) and the HTTPS front end (ChiliPOS-Web, Caddy) as Windows services that start
       with the PC;
    6. trusts the local HTTPS certificate on this PC, opens the firewall for the private network, and prints the
       links to use.
  Safe to run again: it updates the build and restarts the services. Add -Update to `git pull` first.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -Update     # pull the latest code, rebuild, restart
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -Tailscale  # also reach it from phones on any network
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -CheckOnly  # only check Node.js, MongoDB and the other tools
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -DryRun     # show what would be done
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -Uninstall  # remove the services (keeps data)
#>
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\chili-pos',
  [string]$RepoUrl = 'https://github.com/muzamilafey/afeyrestaurant.git',
  [string]$Branch = 'main',
  [string]$Database = 'chili_pos',
  [switch]$Update,
  [switch]$SkipPrerequisites,
  [switch]$DryRun,
  [switch]$CheckOnly,
  [switch]$Tailscale,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 on older .NET does not enable TLS 1.2 by default (needed for https://localhost checks).
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "    $m" -ForegroundColor Green }
function Info($m) { Write-Host "    $m" }
function Warn($m) { Write-Host "    ! $m" -ForegroundColor Yellow }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function New-Secret([int]$bytes) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [Convert]::ToBase64String($b)
}
# Run a native tool whose messages on stderr must not abort the script (nssm, mongosh, caddy); returns its output.
function Quiet([scriptblock]$block) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $block 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $old }
}
function Run([string]$what, [scriptblock]$block) {
  if ($DryRun) { Info "[dry run] $what"; return }
  & $block
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" }
}

$programData = if ($env:ProgramData) { $env:ProgramData } else { [IO.Path]::GetTempPath() } # dry run on non-Windows
$stateDir = Join-Path $programData 'ChiliPOS'
$binDir = Join-Path $stateDir 'bin'
$stateFile = Join-Path $stateDir 'install.json'
$apiService = 'ChiliPOS'
$webService = 'ChiliPOS-Web'
# -Tailscale is remembered, so later runs (e.g. -Update) keep publishing to Tailscale.
if (-not $Tailscale -and (Test-Path $stateFile)) { try { if ((Get-Content $stateFile -Raw | ConvertFrom-Json).tailscale) { $Tailscale = $true } } catch { } }
$tsPort = 8088

# -- 0. Administrator ---------------------------------------------------------------------------
if (-not $DryRun -and -not $CheckOnly) {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Please run this in PowerShell opened with "Run as administrator".'
  }
}

$nssm = Join-Path $binDir 'nssm.exe'

if ($Uninstall) {
  Step 'Removing Chili POS services (the database, settings and code are kept)'
  $tsExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (-not $DryRun -and (Test-Path $tsExe)) { Quiet { & $tsExe serve reset } | Out-Null; Ok 'stopped publishing Chili POS on Tailscale' }
  foreach ($s in @($webService, $apiService)) {
    if (Get-Service $s -ErrorAction SilentlyContinue) {
      if (-not $DryRun) { Quiet { & $nssm stop $s confirm } | Out-Null; Quiet { & $nssm remove $s confirm } | Out-Null }
      Ok "removed $s"
    }
  }
  return
}

# -- 1. Prerequisites: check every tool, install or upgrade only what is missing ----------------
function Test-Present([scriptblock]$present) { try { [bool](& $present) } catch { $false } }
function Find-Exe([string]$name, [string[]]$extra) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in $extra) { $hit = Get-ChildItem $p -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1; if ($hit) { return $hit.FullName } }
  return $null
}
# First "1.2" or "1.2.3" in a tool's version output.
function Get-Ver([scriptblock]$cmd) {
  try {
    $out = (Quiet $cmd) -join ' '
    if ($out -match '(\d+\.\d+(\.\d+)?)') { return $Matches[1] }
  } catch { }
  return $null
}
function Get-MongodExe {
  try {
    $svc = Get-CimInstance Win32_Service -ErrorAction Stop | Where-Object { $_.PathName -match 'mongod(\.exe)?["\s]' } | Select-Object -First 1
    if ($svc) { $m = [regex]::Match($svc.PathName, '^"?([^"]*mongod(\.exe)?)'); if ($m.Success) { return $m.Groups[1].Value } }
  } catch { }
  return $null
}

# Name, winget id, minimum version, how to find the installed version. Order = install order.
$tools = @(
  @{ Name = 'Node.js'; Id = 'OpenJS.NodeJS.LTS'; Min = '20.0'; Find = { $e = Find-Exe 'node' @("$env:ProgramFiles\nodejs\node.exe"); if ($e) { Get-Ver { & $e -v } } } }
  @{ Name = 'npm'; Id = $null; Min = '9.0'; Find = { $e = Find-Exe 'npm.cmd' @("$env:ProgramFiles\nodejs\npm.cmd"); if (-not $e) { $e = Find-Exe 'npm' @() }; if ($e) { Get-Ver { & $e -v } } }; Note = 'comes with Node.js' }
  @{ Name = 'Git'; Id = 'Git.Git'; Min = '2.0'; Find = { $e = Find-Exe 'git' @("$env:ProgramFiles\Git\cmd\git.exe"); if ($e) { Get-Ver { & $e --version } } } }
  @{ Name = 'MongoDB Server'; Id = 'MongoDB.Server'; Min = '5.0'; NoUpgrade = $true; Find = { $e = Get-MongodExe; if ($e) { Get-Ver { & $e --version } } } }
  @{ Name = 'MongoDB Shell (mongosh)'; Id = 'MongoDB.Shell'; Min = '1.0'; Find = { $e = Find-Exe 'mongosh' @("$env:ProgramFiles\mongosh\mongosh.exe", "$env:LOCALAPPDATA\Programs\mongosh\mongosh.exe"); if ($e) { Get-Ver { & $e --version } } } }
  @{ Name = 'MongoDB Database Tools'; Id = 'MongoDB.DatabaseTools'; Min = '100.0'; Find = { $e = Find-Exe 'mongodump' @("$env:ProgramFiles\MongoDB\Tools\*\bin\mongodump.exe"); if ($e) { Get-Ver { & $e --version } } } }
  @{ Name = 'NSSM'; Id = 'NSSM.NSSM'; Min = '2.24'; Find = { $e = Find-Exe 'nssm' @($nssm, "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\NSSM*\*\win64\nssm.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\NSSM*\*\*\win64\nssm.exe"); if ($e) { $v = (Get-Item $e).VersionInfo.ProductVersion; if ($v -match '(\d+\.\d+)') { $Matches[1] } else { '2.24' } } }
     Fallback = {
       $zip = Join-Path $env:TEMP 'nssm-2.24.zip'
       Invoke-WebRequest 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip -UseBasicParsing
       Expand-Archive $zip -DestinationPath $env:TEMP -Force
       New-Item -ItemType Directory -Force $binDir | Out-Null
       Copy-Item (Join-Path $env:TEMP 'nssm-2.24\win64\nssm.exe') $nssm -Force
     } }
  @{ Name = 'Caddy'; Id = 'CaddyServer.Caddy'; Min = '2.6'; Find = { $e = Find-Exe 'caddy' @((Join-Path $binDir 'caddy.exe'), "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\CaddyServer*\*\caddy.exe"); if ($e) { Get-Ver { & $e version } } } }
)
if ($Tailscale) {
  $tools += @{ Name = 'Tailscale'; Id = 'Tailscale.Tailscale'; Min = '1.60'; Find = { $e = Find-Exe 'tailscale' @("$env:ProgramFiles\Tailscale\tailscale.exe"); if ($e) { Get-Ver { & $e version } } } }
}

function Test-Tools {
  foreach ($t in $tools) {
    $found = $null
    try { $found = & $t.Find } catch { }
    $status = if (-not $found) { 'MISSING' } elseif ([version]($found -replace '^(\d+\.\d+).*', '$1') -lt [version]$t.Min) { 'TOO OLD' } else { 'OK' }
    [pscustomobject]@{ Tool = $t.Name; Needed = "$($t.Min)+"; Found = $(if ($found) { $found } else { '-' }); Status = $status; Def = $t }
  }
}
function Show-Tools($rows, [string]$title) {
  Write-Host ""
  Write-Host ("    {0,-26} {1,-9} {2,-12} {3}" -f $title, 'Needed', 'Found', 'Status') -ForegroundColor Gray
  Write-Host ("    {0,-26} {1,-9} {2,-12} {3}" -f ('-' * 26), ('-' * 9), ('-' * 12), ('-' * 18)) -ForegroundColor DarkGray
  foreach ($r in $rows) {
    $color = switch ($r.Status) { 'OK' { 'Green' } 'TOO OLD' { 'Yellow' } default { 'Red' } }
    $action = switch ($r.Status) { 'OK' { 'OK' } 'TOO OLD' { if ($r.Def.NoUpgrade) { 'TOO OLD - upgrade manually' } elseif ($r.Def.Id) { 'TOO OLD - will upgrade' } else { 'TOO OLD' } } default { if ($r.Def.Id) { 'MISSING - will install' } else { "MISSING ($($r.Def.Note))" } } }
    Write-Host ("    {0,-26} {1,-9} {2,-12} " -f $r.Tool, $r.Needed, $r.Found) -NoNewline
    Write-Host $action -ForegroundColor $color
  }
}
function Get-PortOwner([int]$port) {
  try {
    $l = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($l) { $p = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue; return "$($p.ProcessName) (PID $($l.OwningProcess))" }
  } catch { }
  return $null
}
function Show-System {
  Write-Host ""
  Write-Host ("    {0,-26} {1}" -f 'System', 'Result') -ForegroundColor Gray
  Write-Host ("    {0,-26} {1}" -f ('-' * 26), ('-' * 40)) -ForegroundColor DarkGray
  $os = try { (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).Caption } catch { [Environment]::OSVersion.VersionString }
  Write-Host ("    {0,-26} {1}" -f 'Windows', $os)
  Write-Host ("    {0,-26} {1}" -f 'PowerShell', $PSVersionTable.PSVersion)
  $wg = if (Has 'winget') { Get-Ver { winget --version } } else { $null }
  Write-Host ("    {0,-26} " -f 'winget (App Installer)') -NoNewline
  if ($wg) { Write-Host $wg -ForegroundColor Green } else { Write-Host 'MISSING - install "App Installer" from the Microsoft Store' -ForegroundColor Red }
  $isAdmin = try { (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { $false }
  Write-Host ("    {0,-26} " -f 'Administrator') -NoNewline
  if ($isAdmin) { Write-Host 'yes' -ForegroundColor Green } else { Write-Host 'no - right-click PowerShell, "Run as administrator"' -ForegroundColor Red }
  $drive = try { Get-PSDrive ($env:SystemDrive -replace ':', '') -ErrorAction Stop } catch { $null }
  if ($drive) {
    $gb = [math]::Round($drive.Free / 1GB, 1)
    Write-Host ("    {0,-26} " -f "Free disk ($env:SystemDrive)") -NoNewline
    if ($gb -ge 5) { Write-Host "$gb GB" -ForegroundColor Green } else { Write-Host "$gb GB - at least 5 GB recommended" -ForegroundColor Yellow }
  }
  foreach ($port in 4000, 443, 80) {
    $owner = Get-PortOwner $port
    $ours = $owner -and ($owner -match '^(node|caddy)\b')
    if ($owner -and $owner -match '^tailscaled\b' -and $port -eq 443) {
      Write-Host ("    {0,-26} " -f "Port $port") -NoNewline
      Write-Host "used by Tailscale on its own address (fine, Chili POS shares it)" -ForegroundColor Green
      continue
    }
    Write-Host ("    {0,-26} " -f "Port $port") -NoNewline
    if (-not $owner) { Write-Host 'free' -ForegroundColor Green }
    elseif ($ours) { Write-Host "in use by $owner (Chili POS or a dev server - stopped/replaced during install)" -ForegroundColor Yellow }
    else { Write-Host "in use by $owner - stop it before installing" -ForegroundColor Red }
  }
}

$checkOnlyFailed = $false
if (-not $SkipPrerequisites) {
  Step 'Checking this PC'
  Show-System
  $rows = @(Test-Tools)
  Show-Tools $rows 'Tool'
  $todo = @($rows | Where-Object { $_.Status -ne 'OK' })

  if ($CheckOnly) {
    if ($todo.Count) { Write-Host "`n    $($todo.Count) tool(s) need installing or upgrading - run without -CheckOnly to do it." -ForegroundColor Yellow; $checkOnlyFailed = $true }
    else { Write-Host "`n    Everything needed is installed." -ForegroundColor Green }
  } elseif ($todo.Count) {
    Step "Installing / upgrading $($todo.Count) tool(s)"
    if (-not $DryRun -and -not (Has 'winget')) { throw 'winget is missing. Install "App Installer" from the Microsoft Store, then run this again.' }
    foreach ($r in $todo) {
      $t = $r.Def
      if (-not $t.Id) { continue } # npm: comes with Node.js
      if ($r.Status -eq 'TOO OLD' -and $t.NoUpgrade) {
        throw "$($t.Name) $($r.Found) is older than $($t.Min). Upgrade MongoDB manually (major versions one at a time, see https://www.mongodb.com/docs/manual/release-notes/), then run this again. Your data has not been touched."
      }
      $verb = if ($r.Status -eq 'TOO OLD') { 'upgrade' } else { 'install' }
      Info "$verb $($t.Name) ($($t.Id)) ..."
      if ($DryRun) { Info "[dry run] winget $verb $($t.Id)"; continue }
      winget $verb --id $t.Id -e --silent --accept-package-agreements --accept-source-agreements
      $code = $LASTEXITCODE
      Refresh-Path
      if ($code -ne 0 -and $verb -eq 'upgrade') { winget install --id $t.Id -e --silent --accept-package-agreements --accept-source-agreements; $code = $LASTEXITCODE; Refresh-Path }
      $now = try { & $t.Find } catch { $null }
      if (-not $now -and $t.Fallback) { Warn "winget could not install $($t.Id) (exit $code) - downloading it directly"; & $t.Fallback; $now = try { & $t.Find } catch { $null } }
      if (-not $now) { throw "$($t.Name) did not install (winget exit code $code). Install it manually, then run this again." }
      Ok "$($t.Name) $now"
    }
    if (-not $DryRun) {
      $after = @(Test-Tools)
      Show-Tools $after 'Tool (after install)'
      $still = @($after | Where-Object { $_.Status -ne 'OK' })
      if ($still.Count) { throw "Still missing or too old: $(($still | ForEach-Object { $_.Tool }) -join ', '). Install them manually (or restart PowerShell so PATH updates), then run this again." }
    }
  } else {
    Ok 'all tools are installed'
  }

  # Services run as SYSTEM, so keep their programs in a machine-wide folder (winget may install portable tools per user).
  if (-not $DryRun -and -not $CheckOnly) {
    New-Item -ItemType Directory -Force $binDir | Out-Null
    foreach ($tool in @('nssm', 'caddy')) {
      $target = Join-Path $binDir "$tool.exe"
      if (-not (Test-Path $target)) {
        $src = Find-Exe $tool @("$env:LOCALAPPDATA\Microsoft\WinGet\Packages\*\*\$tool.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\*\*\*\$tool.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\*\*\win64\$tool.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\*\*\*\win64\$tool.exe")
        if (-not $src) { throw "$tool.exe not found after installing it." }
        [IO.File]::Copy($src, $target, $true) # follows winget's symlink to the real file
      }
    }
    foreach ($dir in @((Split-Path (Find-Exe 'mongosh' @("$env:ProgramFiles\mongosh\mongosh.exe", "$env:LOCALAPPDATA\Programs\mongosh\mongosh.exe")) -ErrorAction SilentlyContinue), (Split-Path (Find-Exe 'node' @("$env:ProgramFiles\nodejs\node.exe")) -ErrorAction SilentlyContinue), (Split-Path (Find-Exe 'git' @("$env:ProgramFiles\Git\cmd\git.exe")) -ErrorAction SilentlyContinue))) {
      if ($dir -and ($env:Path -split ';') -notcontains $dir) { $env:Path = "$dir;$env:Path" }
    }
  }
}
if ($CheckOnly) {
  if ($checkOnlyFailed) { exit 1 } else { exit 0 }
}
$caddy = Join-Path $binDir 'caddy.exe'

# -- 2. Code ------------------------------------------------------------------------------------
Step 'Getting the code'
$root = $null
if ($PSScriptRoot) {
  $candidate = Resolve-Path (Join-Path $PSScriptRoot '..\..') -ErrorAction SilentlyContinue
  if ($candidate -and (Test-Path (Join-Path $candidate 'server\package.json'))) { $root = $candidate.Path }
}
if (-not $root) {
  $root = $InstallDir
  if (-not (Test-Path (Join-Path $root 'server\package.json'))) {
    Run "git clone $RepoUrl" { git clone --branch $Branch $RepoUrl $root }
  }
}
if ($Update) { Run 'git pull' { git -C $root pull --ff-only } }
Ok "Chili POS folder: $root"

# -- 3. MongoDB replica set (transactions) -----------------------------------------------------
Step 'Preparing MongoDB (single-node replica set, existing data is kept)'
$rsScript = Join-Path $root 'scripts\windows\enable-mongodb-replica-set.ps1'
# Our services depend on MongoDB; stop them while MongoDB may restart (they are started again in step 6).
if (-not $DryRun) {
  foreach ($svcName in @($webService, $apiService)) {
    if (Get-Service $svcName -ErrorAction SilentlyContinue) { Stop-Service $svcName -Force -ErrorAction SilentlyContinue }
  }
}
Run 'enable replica set' { powershell -NoProfile -ExecutionPolicy Bypass -File $rsScript -Apply }
$setName = 'rs0'
if (-not $DryRun) {
  $found = Quiet { mongosh 'mongodb://127.0.0.1:27017/?directConnection=true' --quiet --eval 'db.hello().setName' } | Where-Object { $_ -match '^\w+$' } | Select-Object -Last 1
  if ($found) { $setName = "$found".Trim() }
}
Ok "replica set: $setName"

# -- 4. Settings --------------------------------------------------------------------------------
Step 'Production settings'
$state = @{}
if (Test-Path $stateFile) { (Get-Content $stateFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = $_.Value } }
# Reuse secrets from an existing server\.env so encrypted integration settings stay readable.
$dotenv = @{}
$envFile = Join-Path $root 'server\.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) { if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $dotenv[$Matches[1]] = $Matches[2].Trim('"').Trim("'") } }
}
if (-not $state.jwt) { $state.jwt = if ($dotenv.JWT_ACCESS_SECRET -and -not $dotenv.JWT_ACCESS_SECRET.StartsWith('dev-')) { $dotenv.JWT_ACCESS_SECRET } else { New-Secret 48 } }
if (-not $state.key) { $state.key = if ($dotenv.SECRETS_ENCRYPTION_KEY) { $dotenv.SECRETS_ENCRYPTION_KEY } else { New-Secret 32 } }
if (-not $state.setupToken) { $state.setupToken = (New-Secret 12) -replace '[^A-Za-z0-9]', '' }
if ($Tailscale) { $state.tailscale = $true }
if (-not $DryRun) {
  New-Item -ItemType Directory -Force $stateDir | Out-Null
  ($state | ConvertTo-Json) | Set-Content -Encoding UTF8 $stateFile
  & icacls $stateFile /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
}

# Tailscale: a private network between this PC and the staff phones that works across any Wi-Fi or mobile data,
# with a real HTTPS certificate (no certificate to install on phones).
$tsExe = $null
$tsName = $null
function Get-TsStatus { try { ((Quiet { & $tsExe status --json }) | Where-Object { $_ -notmatch '^\s*$' }) -join "`n" | ConvertFrom-Json } catch { $null } }
# Runs a tailscale command that may wait for the user in a browser; opens the first login/enable link it prints.
function Invoke-TsInteractive([string[]]$tsArgs, [scriptblock]$done, [int]$seconds = 300) {
  $out = Join-Path $env:TEMP ("chili-ts-{0}.txt" -f [guid]::NewGuid())
  $p = Start-Process $tsExe -ArgumentList $tsArgs -RedirectStandardOutput $out -RedirectStandardError "$out.err" -PassThru -WindowStyle Hidden
  $opened = $false
  for ($i = 0; $i -lt $seconds; $i++) {
    Start-Sleep -Seconds 1
    $text = ((Get-Content $out, "$out.err" -ErrorAction SilentlyContinue) -join "`n")
    if (-not $opened -and $text -match '(https://login\.tailscale\.com/\S+)') {
      $opened = $true
      Info "Opening $($Matches[1]) - sign in / approve there (the same account you will use on the phones)."
      Start-Process $Matches[1]
    }
    if ($p.HasExited -or (& $done)) { break }
  }
  if (-not $p.HasExited) { try { $p.Kill() } catch { } }
  Remove-Item $out, "$out.err" -ErrorAction SilentlyContinue
}
if ($Tailscale -and -not $CheckOnly) {
  Step 'Connecting this PC to Tailscale'
  $tsExe = Find-Exe 'tailscale' @("$env:ProgramFiles\Tailscale\tailscale.exe")
  if ($DryRun) { Info '[dry run] tailscale up; tailscale serve'; $tsName = 'thispc.your-tailnet.ts.net' }
  else {
    if (-not $tsExe) { throw 'Tailscale is not installed (run without -SkipPrerequisites).' }
    $st = Get-TsStatus
    if (-not $st -or $st.BackendState -ne 'Running') {
      Info 'A browser window opens: sign in to Tailscale (a free account is fine).'
      Invoke-TsInteractive @('up', '--timeout', '300s') { $x = Get-TsStatus; $x -and $x.BackendState -eq 'Running' }
      $st = Get-TsStatus
    }
    if (-not $st -or $st.BackendState -ne 'Running') { throw 'Tailscale sign-in did not finish. Run the installer again and complete the sign-in in the browser.' }
    $tsName = "$($st.Self.DNSName)".TrimEnd('.')
    if (-not $tsName) { throw 'Tailscale has no name for this PC. In the Tailscale admin console enable MagicDNS, then run this again.' }
    Ok "this PC on Tailscale: $tsName"
  }
}

# Addresses this PC can be reached at.
$ips = @()
try {
  $ips = @(Get-NetIPConfiguration -ErrorAction Stop | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | ForEach-Object { $_.IPv4Address.IPAddress })
} catch {
  $ips = @([Net.Dns]::GetHostAddresses([Net.Dns]::GetHostName()) | Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not $_.ToString().StartsWith('127.') } | ForEach-Object { $_.ToString() })
}
$ips = @($ips | Select-Object -Unique)
$hostName = ([Net.Dns]::GetHostName()).ToLower()
$hosts = @('localhost') + $ips + @($hostName) | Select-Object -Unique
$origins = ($hosts | ForEach-Object { "https://$_" }) -join ','
$primary = if ($ips.Count) { $ips[0] } else { 'localhost' }
$mongoUri = if ($dotenv.MONGODB_URI -and $dotenv.MONGODB_URI -match 'replicaSet=') { $dotenv.MONGODB_URI } else { "mongodb://127.0.0.1:27017/$Database`?replicaSet=$setName" }
$extraOrigins = if ($dotenv.CORS_ORIGINS) { ($dotenv.CORS_ORIGINS -split ',' | Where-Object { $_ -like 'https://*' }) } else { @() }
$tsOrigins = if ($tsName) { @("https://$tsName") } else { @() }
$allOrigins = (@($origins -split ',') + $extraOrigins + $tsOrigins | Select-Object -Unique) -join ','

# Passed to the service; they take precedence over server\.env (which is left untouched).
$apiEnv = @(
  'NODE_ENV=production', 'PORT=4000', "MONGODB_URI=$mongoUri", "CORS_ORIGINS=$allOrigins", "PUBLIC_API_URL=https://$primary",
  'COOKIE_SECURE=true', 'TRUST_PROXY=loopback', "JWT_ACCESS_SECRET=$($state.jwt)", "SECRETS_ENCRYPTION_KEY=$($state.key)",
  "SETUP_TOKEN=$($state.setupToken)", 'RUN_WORKER_IN_PROCESS=true'
)
Ok "addresses: $($hosts -join ', ')"
Ok "database:  $($mongoUri -replace '//[^@/]*@', '//****@')"

# -- 5. Build -----------------------------------------------------------------------------------
Step 'Installing packages and building (a few minutes the first time)'
# A running Chili POS keeps files in node_modules open, which makes npm hang or fail on Windows: stop it while
# building (tills show Offline for a few minutes and keep selling offline; the services start again below).
if (-not $DryRun) {
  foreach ($svc in $webService, $apiService) {
    if ((Get-Service $svc -ErrorAction SilentlyContinue).Status -eq 'Running') { Info "stopping $svc while updating"; Quiet { & $nssm stop $svc confirm } | Out-Null }
  }
}
$lockFile = Join-Path $root 'package-lock.json'
$lockHash = if (Test-Path $lockFile) { (Get-FileHash $lockFile -Algorithm SHA256).Hash } else { '' }
$haveModules = Test-Path (Join-Path $root 'node_modules\.package-lock.json')
Push-Location $root
try {
  if ($haveModules -and $lockHash -and $state.lockHash -eq $lockHash) {
    Ok 'packages unchanged since the last install - skipping npm ci'
  } else {
    Info 'npm ci: downloading and installing packages (2-10 minutes on Windows; antivirus scanning slows it down)'
    Run 'npm ci' { npm ci --no-audit --no-fund --loglevel=error }
    $state.lockHash = $lockHash
    if (-not $DryRun) { ($state | ConvertTo-Json) | Set-Content -Encoding UTF8 $stateFile }
  }
  Info 'npm run build: building the server, web app and bridge (1-3 minutes)'
  Run 'npm run build' { npm run build }
} finally { Pop-Location }
Ok 'built server, web app and bridge'

# -- 6. Services --------------------------------------------------------------------------------
$logDir = Join-Path $root 'logs'
function Set-NssmService([string]$name, [string]$exe, [string]$arguments, [string]$dir, [string[]]$envPairs, [string]$dependsOn, [string]$display) {
  if ($DryRun) { Info "[dry run] service $name -> $exe $arguments"; return }
  New-Item -ItemType Directory -Force $logDir | Out-Null
  if (Get-Service $name -ErrorAction SilentlyContinue) { Quiet { & $nssm stop $name confirm } | Out-Null } else { Quiet { & $nssm install $name $exe } | Out-Null }
  Quiet { & $nssm set $name Application $exe } | Out-Null
  Quiet { & $nssm set $name AppParameters $arguments } | Out-Null
  Quiet { & $nssm set $name AppDirectory $dir } | Out-Null
  Quiet { & $nssm set $name DisplayName $display } | Out-Null
  Quiet { & $nssm set $name AppStdout (Join-Path $logDir "$name.log") } | Out-Null
  Quiet { & $nssm set $name AppStderr (Join-Path $logDir "$name.log") } | Out-Null
  Quiet { & $nssm set $name AppRotateFiles 1 } | Out-Null
  Quiet { & $nssm set $name AppRotateBytes 10485760 } | Out-Null
  Quiet { & $nssm set $name AppExit Default Restart } | Out-Null
  Quiet { & $nssm set $name Start SERVICE_AUTO_START } | Out-Null
  if ($envPairs) { Quiet { & $nssm set $name AppEnvironmentExtra @envPairs } | Out-Null }
  if ($dependsOn) { Quiet { & $nssm set $name DependOnService $dependsOn } | Out-Null }
  Quiet { & $nssm start $name } | Out-Null
}
function Assert-PortFree([int]$port, [string]$owner) {
  if ($DryRun) { return }
  # Tailscale (tailscale serve) listens on its own 100.x / fd7a: address only; that doesn't clash with Caddy.
  $l = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Where-Object { -not ($_.LocalAddress -match '^100\.' -or $_.LocalAddress -match '^fd7a:') -and (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -ne 'tailscaled' } |
    Select-Object -First 1
  if (-not $l) { return }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($l.OwningProcess)" -ErrorAction SilentlyContinue
  if ($p -and $p.CommandLine -and $p.CommandLine -match [regex]::Escape($owner)) { return } # our own service
  throw "Port $port is already used by $($p.Name) (PID $($l.OwningProcess)). Stop it (for example a running 'npm run dev', IIS or Skype) and run this again."
}

Step 'Starting the backend service'
$mongoSvc = if ($DryRun) { 'MongoDB' } else { (Get-CimInstance Win32_Service | Where-Object { $_.PathName -match 'mongod(\.exe)?["\s]' } | Select-Object -First 1).Name }
if (-not $DryRun -and (Get-Service $apiService -ErrorAction SilentlyContinue)) { Quiet { & $nssm stop $apiService confirm } | Out-Null }
Assert-PortFree 4000 'server\dist\index.js'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
Set-NssmService $apiService $node "`"$(Join-Path $root 'server\dist\index.js')`"" (Join-Path $root 'server') $apiEnv $mongoSvc 'Chili POS (backend)'
if (-not $DryRun) {
  $ready = $false
  for ($i = 0; $i -lt 40 -and -not $ready; $i++) {
    Start-Sleep -Seconds 2
    try { $r = Invoke-RestMethod 'http://127.0.0.1:4000/api/v1/ready' -TimeoutSec 3; $ready = $r.status -eq 'ready' } catch { }
  }
  if (-not $ready) { throw "The backend did not become ready. See $logDir\$apiService.log" }
}
Ok 'backend running on http://127.0.0.1:4000 (only reachable from this PC)'

Step 'Starting the HTTPS front end'
$siteList = ($hosts | ForEach-Object { "https://$_" }) -join ', '
$httpList = ($hosts | ForEach-Object { "http://$_" }) -join ', '
$webRoot = (Join-Path $root 'web\dist') -replace '\\', '/'
$tsSite = if ($Tailscale) { @"

# Tailscale publishes this local-only listener at https://$tsName (Tailscale provides the certificate).
:$tsPort {
	bind 127.0.0.1
	import chili
}
"@ } else { '' }
$caddyfile = @"
# Generated by scripts\windows\install.ps1 - re-run the installer instead of editing this file.
{
	local_certs
}

(chili) {
	encode gzip
	handle /api/* {
		reverse_proxy 127.0.0.1:4000
	}
	handle /uploads/* {
		reverse_proxy 127.0.0.1:4000
	}
	handle {
		root * "$webRoot"
		@app path /index.html /sw.js /registerSW.js
		header @app Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
}

$siteList {
	tls internal
	import chili
}

$httpList {
	redir https://{host}{uri} permanent
}
$tsSite
"@
$caddyDir = Join-Path $stateDir 'caddy'
$caddyFilePath = Join-Path $caddyDir 'Caddyfile'
if ($DryRun) { Info '[dry run] Caddyfile:'; $caddyfile -split "`n" | ForEach-Object { Info "  $_" } }
else {
  New-Item -ItemType Directory -Force $caddyDir | Out-Null
  [IO.File]::WriteAllText($caddyFilePath, $caddyfile, (New-Object Text.UTF8Encoding $false))
  $out = Quiet { & $caddy validate --config $caddyFilePath --adapter caddyfile }
  if ($LASTEXITCODE -ne 0) { $out | ForEach-Object { Warn $_ }; throw 'The generated Caddyfile is not valid.' }
  if (Get-Service $webService -ErrorAction SilentlyContinue) { Quiet { & $nssm stop $webService confirm } | Out-Null }
  Assert-PortFree 443 'caddy'
  Assert-PortFree 80 'caddy'
  if ($Tailscale) { Assert-PortFree $tsPort 'caddy' }
}
# XDG_DATA_HOME keeps Caddy's certificates in C:\ProgramData\ChiliPOS\caddy (not the SYSTEM profile).
Set-NssmService $webService $caddy "run --config `"$caddyFilePath`" --adapter caddyfile" $caddyDir @("XDG_DATA_HOME=$caddyDir\data") $apiService 'Chili POS (web, HTTPS)'

if (-not $DryRun) {
  $rootCrt = Join-Path $caddyDir 'data\caddy\pki\authorities\local\root.crt'
  for ($i = 0; $i -lt 30 -and -not (Test-Path $rootCrt); $i++) { Start-Sleep -Seconds 1 }
  if (-not (Test-Path $rootCrt)) { throw "Caddy did not create its certificate. See $logDir\$webService.log" }
  Import-Certificate -FilePath $rootCrt -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
  Copy-Item $rootCrt (Join-Path $root 'chili-root.crt') -Force
  Ok 'this PC trusts the Chili POS certificate; chili-root.crt is ready for the other tills'

  if (-not (Get-NetFirewallRule -DisplayName 'Chili POS (HTTPS)' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'Chili POS (HTTPS)' -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Action Allow -Profile Private, Domain | Out-Null
  }
  Ok 'firewall: ports 80/443 open on private networks (backend port 4000 stays closed)'

  $ok = $false
  for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
    try { $r = Invoke-RestMethod 'https://localhost/api/v1/ready' -TimeoutSec 5; $ok = $r.status -eq 'ready' } catch { Start-Sleep -Seconds 2 }
  }
  if (-not $ok) { Warn "https://localhost did not answer yet - check $logDir\$webService.log" }

  if ($Tailscale -and $tsName) {
    Step "Publishing Chili POS on Tailscale (https://$tsName)"
    Info 'If Tailscale asks to enable HTTPS / Serve for your account, a browser window opens - approve it.'
    Invoke-TsInteractive @('serve', '--bg', "http://127.0.0.1:$tsPort") { $false } 300
    $tsOk = $false
    for ($i = 0; $i -lt 30 -and -not $tsOk; $i++) {
      try { $r = Invoke-RestMethod "https://$tsName/api/v1/ready" -TimeoutSec 10; $tsOk = $r.status -eq 'ready' } catch { Start-Sleep -Seconds 3 }
    }
    if ($tsOk) { Ok "reachable at https://$tsName" }
    else { Warn "https://$tsName did not answer yet (the first certificate can take a minute). Check with: tailscale serve status" }
  }
}

# -- 7. Done ------------------------------------------------------------------------------------
$configured = $false
if (-not $DryRun) { try { $configured = (Invoke-RestMethod 'http://127.0.0.1:4000/api/v1/business' -TimeoutSec 5).data.configured } catch { } }
$netCategory = try { (Get-NetConnectionProfile -ErrorAction Stop | Select-Object -First 1).NetworkCategory } catch { 'Unknown' }

Write-Host ''
Write-Host '  +--------------------------------------------------------------------+' -ForegroundColor Green
Write-Host '  |  Chili POS is installed and running                                |' -ForegroundColor Green
Write-Host '  +--------------------------------------------------------------------+' -ForegroundColor Green
Write-Host ''
Write-Host "  On this PC:          https://localhost" -ForegroundColor White
foreach ($ip in $ips) { Write-Host "  Other tills/tablets: https://$ip" -ForegroundColor White }
if ($tsName) {
  Write-Host ''
  Write-Host "  Phones (any Wi-Fi or mobile data): https://$tsName" -ForegroundColor Cyan
  Write-Host '    1. Install the "Tailscale" app (Play Store / App Store), sign in with the SAME account, turn it on.'
  Write-Host "    2. Open https://$tsName in Chrome/Safari - no certificate needed. Add it to the home screen."
}
Write-Host ''
if (-not $configured) {
  Write-Host "  First-run setup token: $($state.setupToken)" -ForegroundColor Yellow
  Write-Host '  (the setup screen asks for it once, to create the business and the owner account)'
  Write-Host ''
}
Write-Host '  Other tills: copy chili-root.crt from this folder to each till and install it as a'
Write-Host '  Trusted Root certificate (docs\MULTI-TILL.md, step 7), then open the link above.'
if ("$netCategory" -eq 'Public') { Write-Host "  ! This network is set to Public - tills cannot connect until it is Private:" -ForegroundColor Yellow; Write-Host '    Set-NetConnectionProfile -NetworkCategory Private' }
Write-Host ''
Write-Host "  Services: $apiService (backend), $webService (web) - start automatically with Windows."
Write-Host "  Logs:     $logDir"
Write-Host '  Update:   run this installer again with -Update'
Write-Host ''
if (-not $DryRun) { Start-Process 'https://localhost' }
