param(
    [int]$Port = 15101
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $repo "build-staging\jimeng-smoke"
$configDir = Join-Path $runtime "configs\dev"
New-Item -ItemType Directory -Force -Path $configDir, (Join-Path $runtime "logs"), (Join-Path $runtime "tmp") | Out-Null

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $runtime "package.json"), '{"name":"jimeng-api","version":"1.6.3","type":"commonjs"}', $utf8NoBom)
[IO.File]::WriteAllText((Join-Path $configDir "service.yml"), @"
name: jimeng-api
host: '127.0.0.1'
port: $Port
"@, $utf8NoBom)
[IO.File]::WriteAllText((Join-Path $configDir "system.yml"), @"
requestLog: false
debug: false
log_level: info
tmpDir: ./tmp
logDir: ./logs
logWriteInterval: 200
logFileExpires: 2626560000
tmpFileExpires: 86400000
"@, $utf8NoBom)

$executable = Join-Path $repo "sidecars\jimeng-api\bin\jimeng-api-x86_64-pc-windows-msvc.exe"
$process = Start-Process `
    -FilePath $executable `
    -WorkingDirectory $runtime `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtime "stdout.log") `
    -RedirectStandardError (Join-Path $runtime "stderr.log") `
    -PassThru

try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        Start-Sleep -Milliseconds 150
        if ($process.HasExited) {
            break
        }
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
            if ($health.status -eq "ok") {
                $ready = $true
                break
            }
        }
        catch {}
    }
    if (-not $ready) {
        $stderr = Get-Content (Join-Path $runtime "stderr.log") -Raw -ErrorAction SilentlyContinue
        throw "Jimeng sidecar did not become ready. $stderr"
    }

    $root = Invoke-RestMethod "http://127.0.0.1:$Port/"
    $models = Invoke-RestMethod "http://127.0.0.1:$Port/v1/models"
    $responsePath = Join-Path $runtime "edits-response.txt"
    $editStatus = curl.exe -s -o $responsePath -w "%{http_code}" `
        -X POST "http://127.0.0.1:$Port/v1/images/edits" `
        -H "Content-Type: application/json" `
        -d "{}"

    if ($root.service -ne "jimeng-api") { throw "Unexpected service identity" }
    if ($models.data.Count -lt 20) { throw "Incomplete model catalog: $($models.data.Count)" }
    if ($editStatus -eq "404") { throw "/v1/images/edits alias is not registered" }

    [pscustomobject]@{
        Service = $root.service
        Version = $root.version
        Health = $root.endpoints.health
        ImageEdits = $root.endpoints.edits
        ModelCount = $models.data.Count
        ImageEditsStatus = $editStatus
        ProcessId = $process.Id
    } | Format-List
}
finally {
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
}
