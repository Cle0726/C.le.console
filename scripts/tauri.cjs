const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function stopLockedReleaseExecutables() {
  if (process.platform !== 'win32' || process.argv[2] !== 'build') {
    return;
  }

  // tauri-build replaces every external binary in target/release before it
  // compiles the app. Windows refuses to remove a running executable, so an
  // independently running API sidecar left behind by the previous release
  // otherwise makes tauri-build panic with ERROR_ACCESS_DENIED.
  const releaseDir = path.join(repoRoot, 'target', 'release');
  const escapedReleaseDir = releaseDir.replace(/'/g, "''");
  const command = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$releaseDir = [IO.Path]::GetFullPath('${escapedReleaseDir}').TrimEnd('\\')
$lockedNames = @(
  'cle-cliproxy.exe',
  'cockpit-cliproxy.exe',
  'jimeng-api.exe',
  'cle-console.exe',
  'cle_console.exe'
)
$processes = Get-CimInstance Win32_Process | Where-Object {
  if (-not $_.ExecutablePath) { return $false }
  $executable = [IO.Path]::GetFullPath($_.ExecutablePath)
  $directory = [IO.Path]::GetDirectoryName($executable).TrimEnd('\\')
  $name = [IO.Path]::GetFileName($executable)
  $isReleaseExecutable = $lockedNames -contains $name -or $name.StartsWith('C.le.', [StringComparison]::OrdinalIgnoreCase)
  $directory.Equals($releaseDir, [StringComparison]::OrdinalIgnoreCase) -and $isReleaseExecutable
}
foreach ($process in $processes) {
  Stop-Process -Id $process.ProcessId -Force
  Write-Output ("Stopped release executable holding a build artifact: " + $process.Name + " (PID " + $process.ProcessId + ")")
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(typeof result.status === 'number' ? result.status : 1);
  }
}

function runFinal(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(typeof result.status === 'number' ? result.status : 1);
}

// Run before either the configured-toolchain path or its fallback. The
// fallback exits through runFinal(), so doing this only in the temp-script
// branch would leave locked sidecars untouched on machines without vcvars64.
stopLockedReleaseExecutables();

function runTauriDirect() {
  run(process.execPath, [path.join(repoRoot, 'scripts', 'sync-version.js')]);
  const tauriCliPath = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
  runFinal(process.execPath, [tauriCliPath, ...process.argv.slice(2)]);
}

if (process.platform !== 'win32') {
  run('npm', ['run', 'sync-version']);
  runFinal('npx', ['tauri', ...process.argv.slice(2)]);
}

const vcvars64Path = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';
const goBinPath = 'C:\\Program Files\\Go\\bin';

if (!fs.existsSync(vcvars64Path)) {
  console.warn('vcvars64.bat not found, falling back to the existing shell environment.');
  runTauriDirect();
}

const tempScriptPath = path.join(os.tmpdir(), `cle-console-tauri-${process.pid}.cmd`);
const tauriCliPath = path.join(repoRoot, 'node_modules', '.bin', 'tauri.cmd');
const tauriArgs = process.argv.slice(2);

if (!fs.existsSync(tauriCliPath)) {
  console.warn('Local tauri CLI not found, falling back to the existing shell environment.');
  runTauriDirect();
}

const quotedArgs = tauriArgs.map((arg) => {
  if (/[\s"]/u.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
});
const scriptBody = [
  '@echo off',
  `set "PATH=${goBinPath};%PATH%"`,
  `call "${vcvars64Path}"`,
  'if errorlevel 1 exit /b %errorlevel%',
  'call npm.cmd run sync-version',
  'if errorlevel 1 exit /b %errorlevel%',
  `call "${tauriCliPath}" ${quotedArgs.join(' ')}`.trim(),
].join('\r\n');

fs.writeFileSync(tempScriptPath, scriptBody);

try {
  runFinal('cmd.exe', ['/d', '/c', tempScriptPath]);
} finally {
  fs.rmSync(tempScriptPath, { force: true });
}
