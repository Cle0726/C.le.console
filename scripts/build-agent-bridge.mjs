import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = process.argv[2] || (process.platform === 'darwin'
  ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
  : process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu');
const manifest = resolve(root, 'sidecars/agent2api/server/Cargo.toml');
const result = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', manifest, '--target', target], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const extension = target.includes('windows') ? '.exe' : '';
const output = resolve(root, `sidecars/agent2api/bin/cle-agent-bridge-${target}${extension}`);
mkdirSync(resolve(root, 'sidecars/agent2api/bin'), { recursive: true });
copyFileSync(resolve(root, `sidecars/agent2api/server/target/${target}/release/agent2api-server${extension}`), output);
chmodSync(output, 0o755);
console.log(`Personal-use sidecar: ${output}`);
