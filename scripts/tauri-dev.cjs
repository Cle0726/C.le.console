const { spawnSync } = require('node:child_process');

const env = {
  ...process.env,
  CLE_CONSOLE_PROFILE: process.env.CLE_CONSOLE_PROFILE || 'dev',
  CLE_CONSOLE_API_PORT: process.env.CLE_CONSOLE_API_PORT || '1456',
  VITE_CLE_CONSOLE_PROFILE: process.env.VITE_CLE_CONSOLE_PROFILE || 'dev',
};
const extraArgs = process.argv.slice(2);

const syncResult = spawnSync('npm', ['run', 'sync-version'], {
  stdio: 'inherit',
  env,
});

if (syncResult.status !== 0) {
  process.exit(syncResult.status ?? 1);
}

const tauriResult = spawnSync(
  'tauri',
  ['dev', '--config', 'src-tauri/tauri.dev.conf.json', ...extraArgs],
  {
    stdio: 'inherit',
    env,
  },
);

process.exit(tauriResult.status ?? 1);
