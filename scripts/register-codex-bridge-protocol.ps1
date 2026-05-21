$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$startScript = Join-Path $repoRoot "scripts\start-codex-bridge.ps1"

if (!(Test-Path $startScript)) {
  throw "Start script not found: $startScript"
}

$protocol = "overleafgpt-codex"
$protocolRoot = "HKCU:\Software\Classes\$protocol"
$commandKey = Join-Path $protocolRoot "shell\open\command"
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$command = "`"$powershell`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" `"%1`""

New-Item -Path $protocolRoot -Force | Out-Null
Set-ItemProperty -Path $protocolRoot -Name "(default)" -Value "URL:Chat Overleaf Extended Codex Bridge"
New-ItemProperty -Path $protocolRoot -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null

New-Item -Path $commandKey -Force | Out-Null
Set-ItemProperty -Path $commandKey -Name "(default)" -Value $command

Write-Host "Registered protocol: ${protocol}://start"
Write-Host "Command: $command"
