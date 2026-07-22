import fs from 'node:fs';
import path from 'node:path';

const home = process.env.USERPROFILE || process.env.HOME;
const config = JSON.parse(fs.readFileSync(path.join(home, '.antigravity_cle', 'multi_model_api_service.json'), 'utf8'));
const account = (config.accounts || []).find((item) => item.enabled && item.provider === 'codex' && item.credentialJson?.access_token);
const token = account?.credentialJson?.access_token;
if (!token) throw new Error('No Codex OAuth access token available for Chat2API probe');

const baseUrl = process.env.CHAT2API_BASE_URL || 'http://127.0.0.1:5005';
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 60_000);
try {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
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
