$ErrorActionPreference = 'Stop'

$serviceNames = @('ChiliPOS', 'ChiliPOS-Web')
$nssm = Join-Path $env:ProgramData 'ChiliPOS\bin\nssm.exe'
$sc = Join-Path $env:SystemRoot 'System32\sc.exe'

$services = foreach ($name in $serviceNames) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
  if (-not $service) { throw "Service '$name' is not installed. Run install-windows.cmd first." }
  $service
}

foreach ($service in $services) {
  Set-Service -Name $service.Name -StartupType Automatic

  # NSSM restarts the app process if it exits; Windows restarts NSSM if the service wrapper itself fails.
  if (Test-Path $nssm) {
    & $nssm set $service.Name AppExit Default Restart | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not enable app restart for $($service.Name)." }
  }
  & $sc failure $service.Name 'reset=' '86400' 'actions=' 'restart/5000/restart/5000/restart/5000' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not enable Windows service recovery for $($service.Name)." }
}

# The web service depends on the API service, so start the backend first.
foreach ($service in $services) {
  $service.Refresh()
  if ($service.Status -ne 'Running') { Start-Service -Name $service.Name }
}

$deadline = [DateTime]::UtcNow.AddSeconds(45)
do {
  $pending = @($serviceNames | ForEach-Object { Get-Service -Name $_ } | Where-Object { $_.Status -ne 'Running' })
  if (-not $pending.Count) { break }
  Start-Sleep -Seconds 1
} while ([DateTime]::UtcNow -lt $deadline)

if ($pending.Count) { throw "Services did not start: $(($pending | ForEach-Object Name) -join ', '). Check C:\chili-pos\logs." }

Write-Host 'Chili POS backend and HTTPS front end are running.' -ForegroundColor Green
Write-Host 'They are set to start after reboot and recover automatically if they stop.'
Write-Host 'Open https://localhost on this PC.'
Start-Process 'https://localhost'
