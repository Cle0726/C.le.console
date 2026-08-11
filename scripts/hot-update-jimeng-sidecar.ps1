param(
    [string]$Candidate = "sidecars\jimeng-api\bin\jimeng-api-x86_64-pc-windows-msvc.exe",
    [int]$Port = 15100,
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$BackupLabel = "account-health-fix"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$candidatePath = (Resolve-Path (Join-Path $repo $Candidate)).Path
$targetPath = (Resolve-Path (Join-Path $repo "target\release\jimeng-api.exe")).Path
$runtime = (Resolve-Path "$env:USERPROFILE\.antigravity_cle\jimeng_api_service").Path

if (-not $candidatePath.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase) -or
    -not $targetPath.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Candidate or target escaped the repository"
}

$active = @()
for ($attempt = 0; $attempt -lt 50; $attempt++) {
    $active = @(Get-NetTCPConnection -LocalPort $Port -State Established -ErrorAction SilentlyContinue)
    if ($active.Count -eq 0) {
        break
    }
    Start-Sleep -Milliseconds 100
}
if ($active.Count -gt 0) {
    throw "Port $Port still has $($active.Count) active request(s) after a 5-second drain window"
}

$backupDir = Join-Path $repo "build-staging\backups"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$backupPath = Join-Path $backupDir "jimeng-api.pre-$BackupLabel.exe"
Copy-Item -LiteralPath $targetPath -Destination $backupPath -Force

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
$oldPid = $listener.OwningProcess
$newProcess = $null

try {
    Stop-Process -Id $oldPid -Force
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 100
    }

    Copy-Item -LiteralPath $candidatePath -Destination $targetPath -Force
    $newProcess = Start-Process `
        -FilePath $targetPath `
        -WorkingDirectory $runtime `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtime "logs\stdout-$BackupLabel.log") `
        -RedirectStandardError (Join-Path $runtime "logs\stderr-$BackupLabel.log") `
        -PassThru

    $health = $null
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if ($newProcess.HasExited) { break }
        Start-Sleep -Milliseconds 150
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
            if ($health.status -eq "ok") { break }
        }
        catch {}
    }
    if (-not $health -or $health.status -ne "ok") {
        throw "Updated Jimeng sidecar failed its health check"
    }

    [IO.File]::WriteAllText(
        (Join-Path $runtime "sidecar.pid"),
        "$($newProcess.Id)`n",
        (New-Object System.Text.UTF8Encoding($false))
    )
    [pscustomobject]@{
        OldPid = $oldPid
        NewPid = $newProcess.Id
        Health = $health.status
        Version = $health.version
        Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $targetPath).Hash
        Backup = $backupPath
    }
}
catch {
    if ($newProcess -and -not $newProcess.HasExited) {
        Stop-Process -Id $newProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Copy-Item -LiteralPath $backupPath -Destination $targetPath -Force
    $rollback = Start-Process `
        -FilePath $targetPath `
        -WorkingDirectory $runtime `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtime "logs\stdout-rollback.log") `
        -RedirectStandardError (Join-Path $runtime "logs\stderr-rollback.log") `
        -PassThru
    throw "Hot update failed; rollback process $($rollback.Id) started: $_"
}
