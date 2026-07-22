import fs from 'node:fs';

const file = 'F:\\自动注册\\chat2api\\.env';
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
let found = false;
const updated = lines.map((line) => {
  if (!line.startsWith('PROXY_URL=')) return line;
  found = true;
  return 'PROXY_URL=http://127.0.0.1:7897';
});
if (!found) updated.push('PROXY_URL=http://127.0.0.1:7897');
fs.writeFileSync(file, `${updated.join('\n').replace(/\n+$/, '')}\n`);
console.log(JSON.stringify({ updated: true, backup: `${file}.bak` }));
