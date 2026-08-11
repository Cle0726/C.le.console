param(
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo "third_party\jimeng-api"
$output = Join-Path $repo "sidecars\jimeng-api\bin\jimeng-api-x86_64-pc-windows-msvc.exe"

Push-Location $source
try {
    if (-not $SkipInstall) {
        npm ci
    }
    npm run type-check
    npm run build
    npx --yes esbuild dist/index.cjs --bundle --platform=node --format=cjs --target=node22 --outfile=dist/jimeng-bundle.cjs

    $temporaryOutput = Join-Path $source "jimeng-api.exe"
    npx --yes @yao-pkg/pkg dist/jimeng-bundle.cjs --targets node22-win-x64 --output $temporaryOutput --compress Brotli
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $output) | Out-Null
    Copy-Item -LiteralPath $temporaryOutput -Destination $output -Force
    Remove-Item -LiteralPath $temporaryOutput -Force

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash.ToLowerInvariant()
    Write-Host "Jimeng sidecar: $output"
    Write-Host "SHA256: $hash"
}
finally {
    Pop-Location
}
