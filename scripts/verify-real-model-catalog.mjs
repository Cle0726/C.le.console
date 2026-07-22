import fs from 'node:fs/promises';
import path from 'node:path';

const outputPath = path.resolve('artifacts/multi-model-real-model-catalog.json');
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
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let state = await invoke('multi_model_api_sync_managed_accounts');
  const stableConfig = structuredClone(state.config);
  const key = state.config.apiKeys.find((item) => item.enabled && item.key)?.key;
  if (!key) throw new Error('no enabled downstream key');
  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const definitions = new Map();
  for (const account of state.config.accounts.filter((item) => item.enabled)) {
    for (const model of account.models.filter((item) => item.enabled)) {
      const entry = definitions.get(model.id) || { capabilities: new Set(), providers: new Set() };
      for (const capability of model.capabilities || []) entry.capabilities.add(capability);
      entry.providers.add(account.provider);
      definitions.set(model.id, entry);
    }
  }
  const results = [];
  let testedIndex = 0;
  for (const [model, definition] of [...definitions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const capabilities = [...definition.capabilities];
    const providers = [...definition.providers];
    if (capabilities.includes('image') || capabilities.includes('video') || model === 'codex-auto-review') {
      results.push({ model, providers, capabilities, skipped: true, reason: capabilities.includes('video') ? 'video' : capabilities.includes('image') ? 'image' : 'internal' });
      continue;
    }
    if (testedIndex > 0) {
      state = await invoke('multi_model_api_save_config', { config: stableConfig });
    }
    testedIndex += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    const started = performance.now();
    try {
      const response = await fetch(state.baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply exactly OK' }],
          stream: false,
          max_tokens: 12,
        }),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      const diagnostic = json?.error?.message ?? json?.error ?? json?.message ??
        json?.choices?.[0]?.message?.content ?? (response.ok ? 'ok' : text);
      results.push({
        model,
        providers,
        capabilities,
        skipped: false,
        ok: response.ok,
        status: response.status,
        latencyMs: Math.round(performance.now() - started),
        diagnostic: String(diagnostic ?? '').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500),
      });
    } catch (error) {
      results.push({
        model,
        providers,
        capabilities,
        skipped: false,
        ok: false,
        status: 0,
        latencyMs: Math.round(performance.now() - started),
        diagnostic: String(error?.message ?? error).slice(0, 500),
      });
    } finally {
      clearTimeout(timer);
    }
    await sleep(200);
  }
  return {
    checkedAt: new Date().toISOString(),
    catalogCount: results.length,
    testedCount: results.filter((item) => !item.skipped).length,
    successCount: results.filter((item) => item.ok).length,
    failureCount: results.filter((item) => !item.skipped && !item.ok).length,
    skippedCount: results.filter((item) => item.skipped).length,
    results,
  };
})()`;
const evaluated = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});
socket.close();
if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
const report = evaluated.result?.value;
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  checkedAt: report.checkedAt,
  catalogCount: report.catalogCount,
  testedCount: report.testedCount,
  successCount: report.successCount,
  failureCount: report.failureCount,
  skippedCount: report.skippedCount,
  failures: report.results.filter((item) => !item.skipped && !item.ok),
  skipped: report.results.filter((item) => item.skipped),
}, null, 2));
