import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = [
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.macos.conf.json',
  'src-tauri/Info.plist',
  'src-tauri/icons/icon.icns',
  'src-tauri/native/macos-native-menu/Package.swift',
  'sidecars/cle-cliproxy/go.mod',
  'third_party/jimeng-api/package.json',
  'third_party/jimeng-api/package-lock.json',
  'scripts/build-macos-sidecars.mjs',
  'scripts/build-macos.mjs',
  '.github/workflows/macos-preview.yml',
];

const failures = [];
for (const relativePath of requiredFiles) {
  if (!fs.existsSync(path.join(repoRoot, relativePath))) {
    failures.push(`missing file: ${relativePath}`);
  }
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

const baseConfig = readJson('src-tauri/tauri.conf.json');
const macConfig = readJson('src-tauri/tauri.macos.conf.json');
const packageJson = readJson('package.json');
const macBundle = macConfig.bundle ?? {};
const targets = macBundle.targets ?? [];
const externalBin = macBundle.externalBin ?? [];

for (const target of ['app', 'dmg']) {
  if (!targets.includes(target)) failures.push(`macOS bundle target is missing: ${target}`);
}

for (const sidecar of ['cle-cliproxy', 'jimeng-api']) {
  if (!externalBin.some((entry) => entry.endsWith(`/bin/${sidecar}`))) {
    failures.push(`macOS externalBin is missing: ${sidecar}`);
  }
}

if (externalBin.some((entry) => entry.includes('cockpit-cliproxy'))) {
  failures.push('cockpit-cliproxy must stay out of the macOS bundle until a native binary exists');
}

if (macBundle.macOS?.minimumSystemVersion !== '12.0') {
  failures.push('macOS minimumSystemVersion must match the Swift bridge target (12.0)');
}

if (macBundle.macOS?.signingIdentity !== '-') {
  failures.push('preview builds must use ad-hoc signingIdentity "-"');
}

if (!baseConfig.bundle?.macOS?.infoPlist) failures.push('base config has no macOS Info.plist');
for (const script of ['macos:check', 'macos:sidecars', 'macos:build']) {
  if (!packageJson.scripts?.[script]) failures.push(`package.json script is missing: ${script}`);
}

if (process.platform === 'darwin') {
  for (const command of ['xcodebuild', 'go', 'rustup', 'node', 'npm']) {
    try {
      execFileSync('/usr/bin/which', [command], { stdio: 'ignore' });
    } catch {
      failures.push(`required macOS command is unavailable: ${command}`);
    }
  }
}

if (failures.length > 0) {
  console.error('macOS readiness check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('macOS source readiness: OK');
console.log('- targets: app, dmg');
console.log('- architectures: Apple Silicon by default; Intel can be built separately');
console.log('- minimum system: macOS 12.0');
console.log('- bundled sidecars: cle-cliproxy, jimeng-api');
console.log('- deferred on macOS: cockpit-cliproxy (Claude Web helper)');
if (process.platform !== 'darwin') {
  console.log('- host note: configuration was checked, but native compilation requires macOS');
}
