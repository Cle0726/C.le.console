const fs = require('node:fs');
const logFile = 'f:/C.le.控制台/desktop-src/tmp-helper/claude-network-log.jsonl';
let lastSize = 0;
function check() {
  if (!fs.existsSync(logFile)) return;
  const stat = fs.statSync(logFile);
  if (stat.size <= lastSize) return;
  const text = fs.readFileSync(logFile, 'utf8').slice(lastSize);
  lastSize = stat.size;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'request' && entry.request && entry.request.method === 'POST') {
        console.log(JSON.stringify(entry));
      }
    } catch {}
  }
}
setInterval(check, 1000);
check();
