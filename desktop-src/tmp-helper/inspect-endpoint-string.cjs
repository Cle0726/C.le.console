const fs = require('node:fs');
const exportPath = 'f:/C.le.控制台/desktop-src/tmp-helper/live-auth-export.json';
const json = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
const cookie = (json.cookies || [])
  .filter((item) => item && item.name && item.value)
  .map((item) => `${item.name}=${item.value}`)
  .join('; ');

async function main() {
  const response = await fetch('https://claude.ai/new', {
    headers: {
      cookie,
      'user-agent': 'Mozilla/5.0',
      accept: 'text/html',
    },
  });
  const html = await response.text();
  const scripts = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g)).map((match) => match[1]);
  for (const script of scripts.slice(0, 8)) {
    const url = script.startsWith('http') ? script : `https://claude.ai${script}`;
    const jsResponse = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const text = await jsResponse.text();
    if (text.includes('append_message') || text.includes('chat_conversations') || text.includes('completion')) {
      console.log(JSON.stringify({ script: url, appendMessage: text.includes('append_message'), chatConversations: text.includes('chat_conversations'), completion: text.includes('completion') }, null, 2));
      return;
    }
  }
  console.log(JSON.stringify({ found: false }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
