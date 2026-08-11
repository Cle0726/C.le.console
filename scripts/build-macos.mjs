import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? 'universal-apple-darwin';

if (process.platform !== 'darwin') {
  console.error('The macOS application must be compiled on macOS. Use `npm run macos:check` on other hosts.');
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

run('node', ['scripts/check-macos-readiness.mjs']);
run('node', ['scripts/build-macos-sidecars.mjs', target]);
run('rustup', ['target', 'add', 'aarch64-apple-darwin', 'x86_64-apple-darwin']);
run('npm', ['run', 'tauri', '--', 'build', '--target', target], {
  env: {
    ...process.env,
    CLE_SKIP_CLIPROXY_BUILD: '1',
  },
});
