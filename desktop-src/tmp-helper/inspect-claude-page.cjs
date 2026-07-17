const fs = require('node:fs');
const exportPath = 'f:/C.le.控制台/desktop-src/tmp-helper/live-auth-export.json';
const json = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
const cookie = (json.cookies || [])
  .filter((item) => item && item.name && item.value)
  .map((item) => `${item.name}=${item.value}`)
  .join('; ');

fetch('https://claude.ai/new', {
  headers: {
    cookie,
    'user-agent': 'Mozilla/5.0',
    accept: 'text/html',
  },
})
  .then(async (response) => {
    const text = await response.text();
    const scripts = Array.from(text.matchAll(/<script[^>]+src="([^"]+)"/g)).map((match) => match[1]).slice(0, 20);
    const titleMatch = text.match(/<title>([^<]+)/i);
    console.log(JSON.stringify({
      status: response.status,
      url: response.url,
      title: titleMatch ? titleMatch[1] : null,
      scripts,
    }, null, 2));
  })
  .catch((error) => {
    console.error(error.stack || String(error));
    process.exit(1);
  });
