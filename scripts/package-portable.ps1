param(
    [string]$Workspace = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath($Workspace)
$releaseDir = Join-Path $workspaceRoot 'open-source\C.le.console\release'
$runtimeDir = Join-Path $workspaceRoot 'target\release'
$installerSource = @('target-fix', 'target-check', 'target') |
    ForEach-Object {
        $bundleDir = Join-Path $workspaceRoot ("$_\release\bundle\nsis")
        if (Test-Path -LiteralPath $bundleDir) {
            Get-ChildItem -LiteralPath $bundleDir -File |
                Where-Object { $_.Name -like '*_1.1.4_x64-setup.exe' }
        }
    } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $installerSource) {
    throw 'No v1.1.4 NSIS installer was found in target-fix, target-check, or target.'
}
$stage = Join-Path $workspaceRoot ("target\portable-staging-" + [Guid]::NewGuid().ToString('N'))
$portable = Join-Path $stage 'portable'

if (-not $stage.StartsWith((Join-Path $workspaceRoot 'target') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe staging directory: $stage"
}

$readme = @'
C.le.console 1.1.4 Portable (Windows x64)

1. Extract the whole archive. Do not run the application inside the ZIP.
2. Keep all files and subfolders together.
3. Run the console executable whose filename starts with C.le.
4. Existing account data remains under %USERPROFILE%\.antigravity_cle.

Independent API services
- Run scripts\Start-CleApiServices.ps1 to start ports 1466, 1467, and 4479 independently.
- Closing the console does not stop these independent API processes.
- Run scripts\Stop-CleApiServices.ps1 when you explicitly want to stop them.

Integrity
Verify this archive with the SHA256SUMS.txt published with the release.

Notes
- cle-cliproxy.exe and cockpit-cliproxy.exe are required sidecars; do not delete them.
- Installation package: C.le.console_1.1.4_x64_setup.exe
'@

try {
    New-Item -ItemType Directory -Path $portable, (Join-Path $portable 'scripts'), (Join-Path $portable 'resources') -Force | Out-Null
    $consoleExe = Get-ChildItem -LiteralPath $runtimeDir -File |
        Where-Object { $_.Name -like 'C.le.*.exe' } |
        Select-Object -First 1 -ExpandProperty FullName
    Copy-Item -LiteralPath @(
        $consoleExe,
        (Join-Path $runtimeDir 'cle-cliproxy.exe'),
        (Join-Path $runtimeDir 'cockpit-cliproxy.exe')
    ) -Destination $portable
    Copy-Item -LiteralPath (Join-Path $runtimeDir 'native-menu-icons') -Destination $portable -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $runtimeDir 'scripts\claude-desktop-auth-helper.cjs') -Destination (Join-Path $portable 'scripts')
    Copy-Item -LiteralPath @(
        (Join-Path $workspaceRoot 'scripts\Start-CleApiServices.ps1'),
        (Join-Path $workspaceRoot 'scripts\Stop-CleApiServices.ps1')
    ) -Destination (Join-Path $portable 'scripts')
    Copy-Item -LiteralPath (Join-Path $workspaceRoot 'src-tauri\icons\icon.ico') -Destination (Join-Path $portable 'resources\icon.ico')

    Set-Content -LiteralPath (Join-Path $portable 'README_PORTABLE.txt') -Value $readme -Encoding utf8
    Set-Content -LiteralPath (Join-Path $releaseDir 'C.le.console_1.1.4_x64_portable_README.txt') -Value $readme -Encoding utf8
    Copy-Item -LiteralPath $installerSource -Destination (Join-Path $releaseDir 'C.le.console_1.1.4_x64_setup.exe') -Force

    $zip = Join-Path $releaseDir 'C.le.console_1.1.4_x64_portable.zip'
    if ([IO.File]::Exists($zip)) { [IO.File]::Delete($zip) }
    Compress-Archive -LiteralPath $portable -DestinationPath $zip -CompressionLevel Optimal

    $assets = @(
        'C.le.console_1.1.4_x64_setup.exe',
        'C.le.console_1.1.4_x64_portable.zip',
        'C.le.console_1.1.4_x64_portable_README.txt'
    )
    $sumLines = foreach ($name in $assets) {
        $hash = (Get-FileHash -LiteralPath (Join-Path $releaseDir $name) -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $name"
    }
    Set-Content -LiteralPath (Join-Path $releaseDir 'SHA256SUMS.txt') -Value $sumLines -Encoding ascii
} finally {
    if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage, $true) }
}

Get-ChildItem -LiteralPath $releaseDir -File | Sort-Object Name | Select-Object Name, Length, LastWriteTime
