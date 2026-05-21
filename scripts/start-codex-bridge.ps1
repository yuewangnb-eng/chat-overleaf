$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$logDir = Join-Path $repoRoot "logs"
$outLog = Join-Path $logDir "codex-bridge.out.log"
$errLog = Join-Path $logDir "codex-bridge.err.log"
$launcherLog = Join-Path $logDir "codex-bridge.launcher.log"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Write-BridgeLog {
  param([string]$Message)
  try {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$timestamp] $Message" | Out-File -FilePath $launcherLog -Append -Encoding utf8
  } catch {
    # Logging must not prevent the bridge from starting.
  }
}

$port = if ($env:OVERLEAFGPT_CODEX_BRIDGE_PORT) {
  [int]$env:OVERLEAFGPT_CODEX_BRIDGE_PORT
} else {
  17381
}

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Method Get -TimeoutSec 2
  if ($health.ok -and $health.service -eq "overleafgpt-codex-bridge") {
    Write-BridgeLog "Codex Bridge already listening at http://127.0.0.1:$port"
    exit 0
  }
} catch {
  # Bridge is not reachable yet; start it below.
}

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $processes = ($existing | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
  Write-BridgeLog "Port $port is already used by process id(s): $processes"
  throw "Port $port is already in use, but it is not a healthy OverleafGPT Codex Bridge. Run: Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id `$_ }"
}

Set-Location $repoRoot

$process = Start-Process `
  -FilePath "node" `
  -ArgumentList "bridge\codex-bridge.mjs" `
  -WorkingDirectory $repoRoot `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -WindowStyle Hidden `
  -PassThru

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Method Get -TimeoutSec 2
    if ($health.ok) {
      Write-BridgeLog "Started Codex Bridge process $($process.Id) at http://127.0.0.1:$port"
      exit 0
    }
  } catch {
    # Keep waiting.
  }

  if ($process.HasExited) {
    $errorText = if (Test-Path $errLog) { Get-Content -Path $errLog -Raw -ErrorAction SilentlyContinue } else { "" }
    if ($errorText -match "EADDRINUSE") {
      Write-BridgeLog "Codex Bridge port $port is already in use; treating protocol launch as successful."
      exit 0
    }
  }
}

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Method Get -TimeoutSec 5
  if ($health.ok -and $health.service -eq "overleafgpt-codex-bridge") {
    Write-BridgeLog "Codex Bridge became healthy at http://127.0.0.1:$port"
    exit 0
  }
} catch {
  # Report the timeout below.
}

if (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet) {
  Write-BridgeLog "Port $port is reachable, but /health did not confirm OverleafGPT Codex Bridge."
  throw "Port $port is reachable, but /health did not confirm OverleafGPT Codex Bridge. See logs in $logDir."
}

throw "Codex Bridge did not become healthy after starting process $($process.Id). See logs in $logDir."
