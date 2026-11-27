// Builds the AWS Quick sidecar (GPL-3.0, separate process) from
// sidecars/aws-quick/entry.mjs and the vendored magpie-AWS-Quick-bridge sources.
//   node scripts/build-aws-quick-sidecar.mjs [rust-target-triple]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] || (process.platform === 'darwin'
  ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
  : process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu');
const pkgTargets = {
  'x86_64-pc-windows-msvc': 'node22-win-x64',
  'aarch64-apple-darwin': 'node22-macos-arm64',
  'x86_64-apple-darwin': 'node22-macos-x64',
  'x86_64-unknown-linux-gnu': 'node22-linux-x64',
};
if (!pkgTargets[target]) { console.error(`Unsupported target: ${target}`); process.exit(1); }

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const work = path.join(root, 'sidecars', 'aws-quick', 'build');
const outDir = path.join(root, 'sidecars', 'aws-quick', 'bin');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const bundle = path.join(work, 'cle-aws-quick.cjs');
run('npx', ['--yes', 'esbuild@0.25.10', 'sidecars/aws-quick/entry.mjs', '--bundle', '--platform=node',
  '--format=cjs', '--target=node22', `--outfile=${bundle}`]);

const ext = target.includes('windows') ? '.exe' : '';
const output = path.join(outDir, `cle-aws-quick-${target}${ext}`);
const isMac = target.includes('apple-darwin');
run('npx', ['--yes', '@yao-pkg/pkg@6.22.0', bundle, '--targets', pkgTargets[target], '--output', output,
  ...(isMac ? ['--sea', '--no-signature'] : ['--compress', 'Brotli'])]);
if (isMac && process.platform === 'darwin') {
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', output]);
  run('codesign', ['--verify', '--strict', '--verbose=2', output]);
}
if (!ext) fs.chmodSync(output, 0o755);
console.log(`AWS Quick sidecar: ${output}`);
