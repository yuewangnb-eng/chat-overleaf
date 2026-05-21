param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$buildDir = Join-Path $repoRoot "build\chrome-mv3-prod"
$distDir = Join-Path $repoRoot "dist"
$releaseRoot = Join-Path $distDir "OverleafGPT-Friend-Release"
$packageRoot = Join-Path $releaseRoot "OverleafGPT"
$zipStageRoot = Join-Path $distDir "_zip-stage"
$zipStagePackageRoot = Join-Path $zipStageRoot "OverleafGPT"
$extensionDir = Join-Path $packageRoot "extension"
$bridgeDir = Join-Path $packageRoot "bridge"
$scriptsDir = Join-Path $packageRoot "scripts"

if (!$SkipBuild) {
  Push-Location $repoRoot
  try {
    corepack pnpm build
    if ($LASTEXITCODE -ne 0) {
      throw "Build failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

if (!(Test-Path $buildDir)) {
  throw "Extension build not found: $buildDir. Run corepack pnpm build first."
}

if (Test-Path $releaseRoot) {
  Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}
if (Test-Path $zipStageRoot) {
  Remove-Item -LiteralPath $zipStageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $extensionDir, $bridgeDir, $scriptsDir -Force | Out-Null

Copy-Item -Path (Join-Path $buildDir "*") -Destination $extensionDir -Recurse -Force
Copy-Item -Path (Join-Path $repoRoot "bridge\codex-bridge.mjs") -Destination $bridgeDir -Force
Copy-Item -Path (Join-Path $repoRoot "scripts\start-codex-bridge.ps1") -Destination $scriptsDir -Force
Copy-Item -Path (Join-Path $repoRoot "scripts\register-codex-bridge-protocol.ps1") -Destination $scriptsDir -Force

$installBat = @'
@echo off
setlocal
cd /d "%~dp0"
echo Starting OverleafGPT installer...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
echo Installer exited with code %ERRORLEVEL%.
pause
'@

$installScript = @'
$ErrorActionPreference = "Stop"

$packageRoot = $PSScriptRoot
$extensionDir = Join-Path $packageRoot "extension"
$registerScript = Join-Path $packageRoot "scripts\register-codex-bridge-protocol.ps1"
$startScript = Join-Path $packageRoot "scripts\start-codex-bridge.ps1"
$logDir = Join-Path $packageRoot "logs"
$installLog = Join-Path $logDir "install.log"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
try {
  Start-Transcript -Path $installLog -Append | Out-Null
} catch {
  # Transcript is best-effort only.
}

$completed = $false

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Add-CommonNodePaths {
  $paths = @(
    (Join-Path $env:APPDATA "npm"),
    "$env:ProgramFiles\nodejs"
  ) | Where-Object { $_ -and (Test-Path $_) }

  foreach ($path in $paths) {
    if (($env:Path -split ";") -notcontains $path) {
      $env:Path = "$path;$env:Path"
    }
  }
}

function Open-ExtensionInstructions {
  Write-Step "Opening browser extension page"
  Write-Host "Chrome/Edge cannot load an unpacked extension fully automatically outside the Web Store." -ForegroundColor Yellow
  Write-Host "In the extension page: enable Developer mode, click Load unpacked, then select:" -ForegroundColor Yellow
  Write-Host $extensionDir -ForegroundColor Green
  Start-Process explorer.exe $extensionDir

  try {
    Start-Process chrome.exe "chrome://extensions/"
  } catch {
    try {
      Start-Process msedge.exe "edge://extensions/"
    } catch {
      Write-Host "Could not open Chrome/Edge automatically. Please open chrome://extensions/ manually." -ForegroundColor Yellow
    }
  }
}

try {
  Write-Step "Unblocking package files"
  Get-ChildItem -Path $packageRoot -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

  Write-Step "Checking Node.js"
  Add-CommonNodePaths
  if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found on PATH."
  }
  node --version

  Write-Step "Checking Codex CLI"
  Add-CommonNodePaths
  if (!(Get-Command codex -ErrorAction SilentlyContinue)) {
    Write-Host "Codex CLI is not installed. It is only needed for the Codex provider." -ForegroundColor Yellow
    $answer = Read-Host "Install Codex CLI now with npm install -g @openai/codex? [Y/n]"
    if ($answer -notmatch "^(n|N)") {
      if (!(Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm was not found. Reinstall Node.js with npm enabled, then rerun install.bat."
      }
      npm install -g @openai/codex
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to install Codex CLI."
      }
      Add-CommonNodePaths
    }
  }

  if (Get-Command codex -ErrorAction SilentlyContinue) {
    Write-Host "If Codex has not been logged in on this computer, run: codex login" -ForegroundColor Yellow
  } else {
    Write-Host "Codex CLI is still not available. The browser extension can be installed, but the Codex provider will not work yet." -ForegroundColor Yellow
  }

  Write-Step "Registering local Codex Bridge launcher"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $registerScript

  Write-Step "Starting local Codex Bridge"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $startScript

  Open-ExtensionInstructions

  Write-Host ""
  Write-Host "Install helper finished. Keep this OverleafGPT folder in place; the Codex Bridge launcher points to it." -ForegroundColor Green
  Write-Host "Install log: $installLog" -ForegroundColor Green
  $completed = $true
} catch {
  Write-Host ""
  Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
  if ($_.Exception.Message -match "Node\.js was not found") {
    Write-Host "Node.js is required. Please install it from https://nodejs.org/ and run this installer again." -ForegroundColor Yellow
    Write-Host "After installing Node.js, close this window and double-click install.bat again." -ForegroundColor Yellow
    Start-Process "https://nodejs.org/"
  } elseif ($_.Exception.Message -match "npm was not found") {
    Write-Host "npm is required for installing Codex CLI. Reinstall Node.js with npm enabled, then rerun install.bat." -ForegroundColor Yellow
  } elseif ($_.Exception.Message -match "Port .* already in use") {
    Write-Host "Another process is using the Codex Bridge port. Close it, then rerun install.bat." -ForegroundColor Yellow
  }
  Write-Host "Install log: $installLog" -ForegroundColor Yellow
  exit 1
} finally {
  try {
    Stop-Transcript | Out-Null
  } catch {
    # Ignore transcript cleanup errors.
  }

  if (!$completed) {
    Write-Host ""
  }
  Read-Host "Press Enter to close"
}
'@

$uninstallScript = @'
$ErrorActionPreference = "Stop"

$protocolRoot = "HKCU:\Software\Classes\overleafgpt-codex"
if (Test-Path $protocolRoot) {
  Remove-Item -Path $protocolRoot -Recurse -Force
  Write-Host "Removed overleafgpt-codex:// protocol registration."
} else {
  Write-Host "overleafgpt-codex:// protocol registration was not found."
}

$connections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 17381 -State Listen -ErrorAction SilentlyContinue
if ($connections) {
  $answer = Read-Host "Stop the local Codex Bridge process on port 17381 now? [y/N]"
  if ($answer -match "^(y|Y)") {
    $connections |
      Select-Object -ExpandProperty OwningProcess -Unique |
      ForEach-Object { Stop-Process -Id $_ -ErrorAction SilentlyContinue }
    Write-Host "Stopped processes listening on 127.0.0.1:17381."
  }
}

Read-Host "Press Enter to close"
'@

$readme = @'
OverleafGPT Friend Release
==========================

Quick install
-------------

1. Double-click install.bat.
2. If Windows blocks the script, right-click the zip before extracting, choose Properties, click Unblock, then extract again.
3. You can also open PowerShell in this folder and run:

   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

4. The installer opens chrome://extensions/ or edge://extensions/ and the extension folder.
5. In Chrome/Edge:
   - Enable Developer mode.
   - Click "Load unpacked".
   - Select the "extension" folder in this package.

If install fails, send logs\install.log to the developer.

Codex provider
--------------

The Codex provider uses the user's own local Codex login. If Codex is not logged in, run:

  codex login

Then open OverleafGPT settings -> Model Service -> Codex -> Connect to local Codex.

ChatGPT Web / DeepSeek Web provider
-----------------------------------

Open and log in to ChatGPT or DeepSeek in the same browser:

  https://chatgpt.com/
  https://chat.deepseek.com/

Then select ChatGPT Web or DeepSeek Web inside OverleafGPT.

Do not share private files
--------------------------

This package does not include your .env, node_modules, logs, API keys, or login tokens.
Each user must log in with their own Codex/ChatGPT/DeepSeek account.

Uninstall
---------

Run uninstall.ps1 to remove the overleafgpt-codex:// protocol registration.
Remove the extension from chrome://extensions/ manually.
'@

Set-Content -Path (Join-Path $packageRoot "install.bat") -Value $installBat -Encoding ASCII
Set-Content -Path (Join-Path $packageRoot "install.ps1") -Value $installScript -Encoding UTF8
Set-Content -Path (Join-Path $packageRoot "uninstall.ps1") -Value $uninstallScript -Encoding UTF8
Set-Content -Path (Join-Path $packageRoot "README.txt") -Value $readme -Encoding UTF8

$fullZip = Join-Path $distDir "OverleafGPT-Friend-Release.zip"
$extensionZip = Join-Path $distDir "OverleafGPT-Extension-Only.zip"
if (Test-Path $fullZip) { Remove-Item -LiteralPath $fullZip -Force }
if (Test-Path $extensionZip) { Remove-Item -LiteralPath $extensionZip -Force }

New-Item -ItemType Directory -Path $zipStageRoot -Force | Out-Null
Copy-Item -Path $packageRoot -Destination $zipStageRoot -Recurse -Force
Compress-Archive -Path (Join-Path $zipStagePackageRoot "*") -DestinationPath $fullZip -Force
Compress-Archive -Path (Join-Path $extensionDir "*") -DestinationPath $extensionZip -Force
Remove-Item -LiteralPath $zipStageRoot -Recurse -Force

Write-Host "Created full friend release: $fullZip"
Write-Host "Created extension-only zip: $extensionZip"
