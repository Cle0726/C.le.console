const { spawnSync } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const viteCli = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
const result = spawnSync(process.execPath, [viteCli, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: false,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
