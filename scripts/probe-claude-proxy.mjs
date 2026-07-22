import fs from 'node:fs';

const source = `${process.env.USERPROFILE}\\.antigravity_cle\\multi_model_api_service\\claude-web\\config.json`;
const target = 'target/claude-proxy-probe/config.json';
const config = JSON.parse(fs.readFileSync(source, 'utf8'));
config.listenPort = 2467;
config.accounts = (config.accounts || []).map((account) => ({
  ...account,
  proxyUrl: process.env.CLE_CLAUDE_PROBE_PROXY || 'http://127.0.0.1:7897',
}));
fs.mkdirSync('target/claude-proxy-probe', { recursive: true });
fs.writeFileSync(target, JSON.stringify(config, null, 2));

if (process.argv.includes('--prepare')) process.exit(0);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 60_000);
try {
  const response = await fetch('http://127.0.0.1:2467/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.localApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      stream: false,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply exactly OK' }],
    }),
    signal: controller.signal,
  });
  const body = await response.text();
  console.log(JSON.stringify({ status: response.status, ok: response.ok, body: body.slice(0, 1000) }));
} catch (error) {
  console.log(JSON.stringify({ status: 0, error: error.message }));
} finally {
  clearTimeout(timer);
}
