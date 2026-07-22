import fs from 'node:fs/promises';
import path from 'node:path';

const cdpPort = Number(process.env.CLE_QA_CDP_PORT || 9225);
const outputPath = path.resolve(
  process.env.CLE_REAL_GATEWAY_REPORT || 'artifacts/multi-model-real-account-e2e.json',
);
const requestedModels = (process.env.CLE_REAL_GATEWAY_MODELS ||
  'gpt-5.4-mini,gemini-2.5-flash,gemini-3-flash')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const skipSync = process.env.CLE_SKIP_MANAGED_ACCOUNT_SYNC === '1';

const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) =>
  response.json(),
);
const target =
  targets.find((item) => item.type === 'page' && item.url.includes('localhost:1420')) ?? targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error('C.le. 调试窗口不可用');

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

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

// Keep credentials inside the WebView/Tauri process.  Only sanitized status,
// latency and short response diagnostics cross the CDP boundary or reach disk.
const expression = `(async () => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error('tauri-internals-missing');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const request = async (url, options = {}, timeoutMs = 90000) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      const diagnostic = json?.error?.message ?? json?.error ?? json?.message ??
        json?.choices?.[0]?.message?.content ?? json?.output?.[0]?.content?.[0]?.text ??
        (response.ok ? 'ok' : text.slice(0, 500));
      return {
        ok: response.ok,
        status: response.status,
        latencyMs: Math.round(performance.now() - started),
        diagnostic: String(diagnostic ?? '').slice(0, 500),
        modelCount: Array.isArray(json?.data) ? json.data.length : undefined,
        modelIds: Array.isArray(json?.data) ? json.data.map((item) => item.id).filter(Boolean) : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        latencyMs: Math.round(performance.now() - started),
        diagnostic: String(error?.message ?? error).slice(0, 500),
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  let state = await invoke(${skipSync ? "'multi_model_api_get_state'" : "'multi_model_api_sync_managed_accounts'"});
  if (!state.running) state = await invoke('multi_model_api_set_enabled', { enabled: true });
  for (let attempt = 0; attempt < 40 && !state.running; attempt += 1) {
    await sleep(250);
    state = await invoke('multi_model_api_get_state');
  }
  if (!state.running) throw new Error(state.lastError || '多模型网关未能启动');
  const downstreamKey = state.config.apiKeys.find((item) => item.enabled)?.key;
  if (!downstreamKey) throw new Error('没有可用的下游 Key');
  const headers = { Authorization: 'Bearer ' + downstreamKey, 'Content-Type': 'application/json' };
  const models = await request(state.baseUrl + '/v1/models', { headers });
  const results = [];
  for (const model of ${JSON.stringify(requestedModels)}) {
    const result = await request(state.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply exactly OK' }],
        stream: false,
        max_tokens: 16,
      }),
    });
    results.push({ model, ...result });
    await sleep(350);
  }
  return {
    checkedAt: new Date().toISOString(),
    baseUrl: state.baseUrl,
    running: state.running,
    accountCount: state.config.accounts.filter((item) => item.enabled).length,
    providers: Object.fromEntries([...new Set(state.config.accounts.map((item) => item.provider))]
      .map((provider) => [provider, state.config.accounts.filter((item) => item.enabled && item.provider === provider).length])),
    models,
    results,
  };
})()`;

const result = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});
socket.close();
if (result.exceptionDetails) {
  throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
}
const report = result.result?.value;
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
