const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(repoRoot, 'target', 'release');
const cargoExecutable = path.join(releaseDir, 'cle-console.exe');
const productExecutable = path.join(releaseDir, 'C.le.控制台.exe');
const stagedExecutable = `${productExecutable}.next`;

function stopRunningProductExecutable() {
  if (process.platform !== 'win32' || !fs.existsSync(productExecutable)) {
    return;
  }

  const escapedTarget = productExecutable.replace(/'/g, "''");
  const command = `
$target = '${escapedTarget}'
$processes = Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.Equals($target, [System.StringComparison]::OrdinalIgnoreCase)
}
foreach ($process in $processes) {
  Stop-Process -Id $process.ProcessId -Force
  Write-Output ("Stopped running C.le.控制台 PID " + $process.ProcessId)
}
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

if (!fs.existsSync(cargoExecutable)) {
  if (fs.existsSync(productExecutable)) {
    console.log(`Release executable is already finalized: ${productExecutable}`);
  } else {
    console.log('No Release executable found; skipping product executable finalization.');
  }
  process.exit(0);
}

fs.mkdirSync(releaseDir, { recursive: true });
stopRunningProductExecutable();
fs.rmSync(stagedExecutable, { force: true });
fs.copyFileSync(cargoExecutable, stagedExecutable);
fs.rmSync(productExecutable, { force: true });
fs.renameSync(stagedExecutable, productExecutable);
fs.rmSync(cargoExecutable, { force: true });

console.log(`Finalized Release executable: ${productExecutable}`);
