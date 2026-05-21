param(
  [string]$LaunchUrl = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$logDir = Join-Path $repoRoot "logs"
$outLog = Join-Path $logDir "codex-bridge.out.log"
$errLog = Join-Path $logDir "codex-bridge.err.log"
$launcherLog = Join-Path $logDir "codex-bridge.launcher.log"
$stateDir = Join-Path $HOME ".overleafgpt"
$pairingFile = Join-Path $stateDir "codex-bridge-pairing.json"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

function Write-BridgeLog {
  param([string]$Message)
  try {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$timestamp] $Message" | Out-File -FilePath $launcherLog -Append -Encoding utf8
  } catch {
    # Logging must not prevent the bridge from starting.
  }
}

function Register-PairingNonceWithRunningBridge {
  param(
    [int]$Port,
    [string]$Nonce
  )

  if (!$Nonce) { return $false }

  try {
    $expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(2).ToUnixTimeMilliseconds()
    $body = @{
      nonce = $Nonce
      expires_at = $expiresAt
    } | ConvertTo-Json -Compress

    $result = Invoke-RestMethod `
      -Uri "http://127.0.0.1:$Port/v1/bridge/register-pairing" `
      -Method Post `
      -ContentType "application/json" `
      -Body $body `
      -TimeoutSec 2

    if ($result.ok) {
      Write-BridgeLog "Registered pairing nonce with running secure Codex Bridge."
      return $true
    }
  } catch {
    Write-BridgeLog "Could not register nonce with running bridge. $($_.Exception.Message)"
  }

  return $false
}

$pairingNonce = ""
if ($LaunchUrl) {
  try {
    $uri = [System.Uri]$LaunchUrl
    foreach ($part in $uri.Query.TrimStart("?").Split("&")) {
      if (!$part) { continue }
      $equalsIndex = $part.IndexOf("=")
      if ($equalsIndex -le 0) { continue }
      $name = $part.Substring(0, $equalsIndex)
      $value = $part.Substring($equalsIndex + 1)
      if ($name -eq "nonce") {
        $pairingNonce = [System.Uri]::UnescapeDataString($value).Trim()
      }
    }
  } catch {
    Write-BridgeLog "Failed to parse launch URL: $LaunchUrl"
  }
}

if ($pairingNonce) {
  $pairingPayload = @{
    nonce = $pairingNonce
    expires_at = (Get-Date).ToUniversalTime().AddMinutes(2).ToString("o")
  } | ConvertTo-Json -Compress
  try {
    [System.IO.File]::WriteAllText($pairingFile, $pairingPayload, [System.Text.Encoding]::UTF8)
    Write-BridgeLog "Stored short-lived Codex Bridge pairing nonce."
  } catch {
    Write-BridgeLog "Could not write pairing file; startup environment nonce will be used for newly started bridges. $($_.Exception.Message)"
  }
}

$port = if ($env:OVERLEAFGPT_CODEX_BRIDGE_PORT) {
  [int]$env:OVERLEAFGPT_CODEX_BRIDGE_PORT
} else {
  17381
}

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Method Get -TimeoutSec 2
  if ($health.ok -and $health.service -eq "overleafgpt-codex-bridge" -and $health.requires_auth -eq $true) {
    if ($pairingNonce) {
      if (Register-PairingNonceWithRunningBridge -Port $port -Nonce $pairingNonce) {
        Write-BridgeLog "Codex Bridge already listening at http://127.0.0.1:$port"
        exit 0
      }

      Write-BridgeLog "Running secure Codex Bridge does not support launcher nonce registration; restarting it."
      $secureBridgeConnections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue
      foreach ($processId in ($secureBridgeConnections | Select-Object -ExpandProperty OwningProcess -Unique)) {
        if ($processId) {
          Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
          Write-BridgeLog "Stopped secure Codex Bridge process $processId for upgrade restart."
        }
      }
      Start-Sleep -Milliseconds 500
    } else {
      Write-BridgeLog "Codex Bridge already listening at http://127.0.0.1:$port"
      exit 0
    }
  }
  if ($health.ok -and $health.service -eq "overleafgpt-codex-bridge") {
    Write-BridgeLog "Old Codex Bridge detected at http://127.0.0.1:$port; restarting it to enable secure pairing."
    $oldBridgeConnections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($pid in ($oldBridgeConnections | Select-Object -ExpandProperty OwningProcess -Unique)) {
      if ($pid) {
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        Write-BridgeLog "Stopped old Codex Bridge process $pid."
      }
    }
    Start-Sleep -Milliseconds 500
  }
} catch {
  # Bridge is not reachable yet; start it below.
}

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $processes = ($existing | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
  Write-BridgeLog "Port $port is already used by process id(s): $processes"
  throw "Port $port is already in use, but it is not a healthy Chat Overleaf Extended Codex Bridge. Run: Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id `$_ }"
}

Set-Location $repoRoot

if ($pairingNonce) {
  $env:OVERLEAFGPT_CODEX_BRIDGE_PAIRING_NONCE = $pairingNonce
  $env:OVERLEAFGPT_CODEX_BRIDGE_PAIRING_EXPIRES_AT = [string]([DateTimeOffset]::UtcNow.AddMinutes(2).ToUnixTimeMilliseconds())
}

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
  Write-BridgeLog "Port $port is reachable, but /health did not confirm Chat Overleaf Extended Codex Bridge."
  throw "Port $port is reachable, but /health did not confirm Chat Overleaf Extended Codex Bridge. See logs in $logDir."
}

throw "Codex Bridge did not become healthy after starting process $($process.Id). See logs in $logDir."
