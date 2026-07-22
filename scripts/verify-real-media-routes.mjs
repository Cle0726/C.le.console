import fs from 'node:fs/promises';
import path from 'node:path';

const outputPath = path.resolve('artifacts/multi-model-real-media-e2e.json');
const targets = await fetch('http://127.0.0.1:9225/json/list').then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.url.includes('localhost:1420')) ?? targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error('C.le. debug WebView is unavailable');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
  else callback.resolve(message.result);
});
const send = (method, params = {}) => {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

const expression = `(async () => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error('tauri-internals-missing');
  const state = await invoke('multi_model_api_sync_managed_accounts');
  const key = state.config.apiKeys.find((item) => item.enabled && item.key)?.key;
  if (!key) throw new Error('no enabled downstream key');
  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const started = performance.now();
  let image;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    const response = await fetch(state.baseUrl + '/v1/images/generations', {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: 'A single small white circle centered on a black background',
        size: '1024x1024',
        n: 1,
      }),
    });
    clearTimeout(timer);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const first = Array.isArray(json?.data) ? json.data[0] : null;
    image = {
      ok: response.ok,
      status: response.status,
      latencyMs: Math.round(performance.now() - started),
      outputCount: Array.isArray(json?.data) ? json.data.length : 0,
      hasImagePayload: Boolean(first?.url || first?.b64_json || first?.revised_prompt),
      diagnostic: String(json?.error?.message ?? json?.error ?? json?.message ?? (response.ok ? 'ok' : text))
        .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500),
    };
  } catch (error) {
    image = {
      ok: false,
      status: 0,
      latencyMs: Math.round(performance.now() - started),
      outputCount: 0,
      hasImagePayload: false,
      diagnostic: String(error?.message ?? error).slice(0, 500),
    };
  }
  const antigravityStarted = performance.now();
  let antigravityImage;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    const response = await fetch(state.baseUrl + '/v1/images/generations', {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: 'gemini-3.1-flash-image',
        prompt: 'A single small white circle centered on a black background',
        size: '1024x1024',
        n: 1,
      }),
    });
    clearTimeout(timer);
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const first = Array.isArray(json?.data) ? json.data[0] : null;
    antigravityImage = {
      model: 'gemini-3.1-flash-image',
      ok: response.ok,
      status: response.status,
      latencyMs: Math.round(performance.now() - antigravityStarted),
      outputCount: Array.isArray(json?.data) ? json.data.length : 0,
      hasImagePayload: Boolean(first?.url || first?.b64_json || first?.revised_prompt),
      diagnostic: String(json?.error?.message ?? json?.error ?? json?.message ?? (response.ok ? 'ok' : text))
        .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500),
    };
  } catch (error) {
    antigravityImage = {
      model: 'gemini-3.1-flash-image',
      ok: false,
      status: 0,
      latencyMs: Math.round(performance.now() - antigravityStarted),
      outputCount: 0,
      hasImagePayload: false,
      diagnostic: String(error?.message ?? error).slice(0, 500),
    };
  }
  const xaiAccounts = state.config.accounts.filter((account) =>
    account.enabled && ['xai', 'grok'].includes(account.provider)
  );
  return {
    checkedAt: new Date().toISOString(),
    images: [{ model: 'gpt-image-2', ...image }, antigravityImage],
    video: {
      realCredentialAvailable: xaiAccounts.length > 0,
      enabledXaiAccountCount: xaiAccounts.length,
      route: '/v1/videos/generations',
      fakeUpstreamRegressionArtifact: 'artifacts/multi-model-gateway-e2e.json',
    },
  };
})()`;
const evaluated = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});
socket.close();
if (evaluated.exceptionDetails) {
  throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
}
const report = evaluated.result?.value;
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
