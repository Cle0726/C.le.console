const { spawnSync } = require('node:child_process');
const path = require('node:path');

if (process.platform !== 'win32') {
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, '..');
const targetExe = path.join(repoRoot, 'target', 'debug', 'cle_console.exe');
const escapedTarget = targetExe.replace(/'/g, "''").toLowerCase();

const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$target = '${escapedTarget}'
try {
  $processes = Get-CimInstance Win32_Process -Filter "Name = 'cle_console.exe'" |
    Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.ToLowerInvariant() -eq $target) }
  foreach ($process in $processes) {
    Stop-Process -Id $process.ProcessId -Force
    Write-Output ("Stopped stale C.le.控制台 debug process PID " + $process.ProcessId)
  }
} catch {
  Write-Warning ("Unable to inspect stale debug processes; continuing the build. " + $_.Exception.Message)
}
`;

const result = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
  {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

if (result.stdout) {
  process.stdout.write(result.stdout);
}

if (result.status !== 0) {
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exit(result.status ?? 1);
}
