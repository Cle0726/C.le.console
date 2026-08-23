import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requestedTarget = process.argv.slice(2).find((argument) => !argument.startsWith('--')) ?? 'aarch64-apple-darwin';
const skipInstall = process.argv.includes('--skip-install');
const supportedTargets = new Set([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
]);

if (process.platform !== 'darwin') {
  console.error('macOS sidecars must be built on macOS. Run `npm run macos:check` for a host-independent check.');
  process.exit(1);
}

if (!supportedTargets.has(requestedTarget)) {
  console.error(`Unsupported macOS target: ${requestedTarget}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function signAndVerifyMacExecutable(filePath) {
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', filePath]);
  run('codesign', ['--verify', '--strict', '--verbose=2', filePath]);
}

const architectures = requestedTarget.startsWith('aarch64')
  ? [{ rust: 'aarch64-apple-darwin', go: 'arm64', pkg: 'arm64' }]
  : [{ rust: 'x86_64-apple-darwin', go: 'amd64', pkg: 'x64' }];

const cleSource = path.join(repoRoot, 'sidecars', 'cle-cliproxy');
const cleOutput = path.join(cleSource, 'bin');
fs.mkdirSync(cleOutput, { recursive: true });

for (const architecture of architectures) {
  const output = path.join(cleOutput, `cle-cliproxy-${architecture.rust}`);
  run('go', [
    'build',
    '-buildvcs=false',
    '-trimpath',
    '-ldflags',
    '-s -w',
    '-o',
    output,
    '.',
  ], {
    cwd: cleSource,
    env: {
      ...process.env,
      GOOS: 'darwin',
      GOARCH: architecture.go,
      CGO_ENABLED: '0',
    },
  });
  fs.chmodSync(output, 0o755);
}

const jimengSource = path.join(repoRoot, 'third_party', 'jimeng-api');
const jimengDist = path.join(jimengSource, 'dist');
const jimengOutput = path.join(repoRoot, 'sidecars', 'jimeng-api', 'bin');
fs.mkdirSync(jimengOutput, { recursive: true });

if (!skipInstall) run('npm', ['ci'], { cwd: jimengSource });
run('npm', ['run', 'type-check'], { cwd: jimengSource });
run('npm', ['run', 'build'], { cwd: jimengSource });
run('npx', [
  '--yes',
  'esbuild@0.25.10',
  'dist/index.cjs',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node22',
  '--outfile=dist/jimeng-bundle.cjs',
], { cwd: jimengSource });

for (const architecture of architectures) {
  const output = path.join(jimengOutput, `jimeng-api-${architecture.rust}`);
  run('npx', [
    '--yes',
    '@yao-pkg/pkg@6.22.0',
    path.join(jimengDist, 'jimeng-bundle.cjs'),
    '--targets',
    `node22-macos-${architecture.pkg}`,
    '--output',
    output,
    '--sea',
    '--no-signature',
  ]);
  signAndVerifyMacExecutable(output);
  fs.chmodSync(output, 0o755);
}

// StoryOS desktop binaries are intentionally split: the workspace sidecar is
// strictly read-only, while the manuscript sidecar may only replace an existing
// working-copy file behind a SHA precondition. Both builders smoke-test and
// ad-hoc sign their Mach-O outputs before Tauri bundles them.
run('python3', [
  'scripts/build-storyos-sidecar.py',
  '--target',
  requestedTarget,
]);
run('python3', [
  'scripts/build-storyos-manuscript-sidecar.py',
  '--target',
  requestedTarget,
]);

console.log(`macOS sidecars ready for ${requestedTarget}`);
