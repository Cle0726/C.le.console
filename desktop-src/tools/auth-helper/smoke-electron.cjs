const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const output = process.argv[2];
if (!output) {
  console.error('missing output path');
  process.exit(2);
}

app.whenReady().then(() => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ ok: true, pid: process.pid }, null, 2));
  app.quit();
});
