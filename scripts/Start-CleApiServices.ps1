param(
    [switch]$ForceRestart
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot
# Installed/portable bundles place the sidecars beside the console executable,
# while a source checkout keeps them under target\release.
$releaseDir = @(
    $packageRoot,
    (Join-Path $packageRoot 'target\release')
) | Where-Object {
    Test-Path -LiteralPath (Join-Path $_ 'cle-cliproxy.exe') -PathType Leaf
} | Select-Object -First 1
if (-not $releaseDir) {
    throw "Cannot locate cle-cliproxy.exe beside the package or under target\release."
}
$dataDir = Join-Path $env:USERPROFILE '.antigravity_cle'
$logDir = Join-Path $dataDir 'standalone_api_services'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$services = @(
    @{
        Name = 'Multi-model API'
        Port = 1466
        Exe = Join-Path $releaseDir 'cle-cliproxy.exe'
        Args = @('--config', (Join-Path $dataDir 'multi_model_api_service\config.json'), '--manifest', (Join-Path $dataDir 'multi_model_api_service\runtime_state.json'))
    },
    @{
        Name = 'Claude Web helper'
        Port = 1467
        Exe = Join-Path $releaseDir 'cockpit-cliproxy.exe'
        Args = @('--config', (Join-Path $dataDir 'multi_model_api_service\claude-web\config.json'), '--runtime-state', (Join-Path $dataDir 'multi_model_api_service\claude-web\runtime.json'))
    },
    @{
        Name = 'Codex API'
        Port = 4479
        Exe = Join-Path $releaseDir 'cle-cliproxy.exe'
        Args = @('--config', (Join-Path $dataDir 'codex_local_access_sidecar\config.json'), '--manifest', (Join-Path $dataDir 'codex_local_access_sidecar\manifest.json'))
    }
)

function Get-PortOwner([int]$Port) {
    Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty OwningProcess
}

foreach ($service in $services) {
    $owner = Get-PortOwner $service.Port
    if ($owner -and $ForceRestart) {
        Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
        $deadline = (Get-Date).AddSeconds(10)
        while ((Get-PortOwner $service.Port) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 200
        }
        $owner = Get-PortOwner $service.Port
    }
    if ($owner) { continue }
    if (-not (Test-Path -LiteralPath $service.Exe -PathType Leaf)) {
        throw "Missing executable: $($service.Exe)"
    }
    foreach ($arg in $service.Args) {
        if ($arg -like '*.json' -and -not (Test-Path -LiteralPath $arg -PathType Leaf)) {
            throw "Missing configuration: $arg"
        }
    }
    $safeName = ($service.Name -replace '[^A-Za-z0-9]+', '-').Trim('-').ToLowerInvariant()
    Start-Process -FilePath $service.Exe -ArgumentList $service.Args -WorkingDirectory $releaseDir `
        -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$safeName.out.log") `
        -RedirectStandardError (Join-Path $logDir "$safeName.err.log") | Out-Null
}

$deadline = (Get-Date).AddSeconds(30)
do {
    $missing = @($services | Where-Object { -not (Get-PortOwner $_.Port) })
    if ($missing.Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
} while ((Get-Date) -lt $deadline)

if ($missing.Count -gt 0) {
    throw "API services failed to listen: $($missing.Port -join ', ')"
}

$services | ForEach-Object {
    [pscustomobject]@{ Name = $_.Name; Port = $_.Port; PID = Get-PortOwner $_.Port; Ready = $true }
}
