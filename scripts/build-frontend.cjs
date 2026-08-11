const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

runNode(path.join(repoRoot, 'scripts', 'sync-version.js'));
runNode(require.resolve('typescript/bin/tsc'), ['--noEmit']);
runNode(path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js'), ['build']);
