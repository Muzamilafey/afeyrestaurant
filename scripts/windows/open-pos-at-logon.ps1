$ErrorActionPreference = 'SilentlyContinue'

# The Windows services start at boot. Wait for HTTPS to be ready before opening the till UI.
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    $ready = Invoke-RestMethod 'https://localhost/api/v1/ready' -TimeoutSec 2
    if ($ready.status -eq 'ready') {
      Start-Process 'https://localhost'
      exit 0
    }
  } catch { }
  Start-Sleep -Seconds 2
}

# Still show the app if the services need more time; Windows can retry on the next sign-in.
Start-Process 'https://localhost'
