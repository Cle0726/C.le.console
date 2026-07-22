import fs from 'node:fs/promises';
import path from 'node:path';

const cdpPort = Number(process.env.CLE_QA_CDP_PORT || 9225);
const outputPath = path.resolve(
  process.env.CLE_ACCOUNT_POOL_REPORT || 'artifacts/multi-model-real-account-pool.json',
);
const providerFilter = (process.env.CLE_ACCOUNT_POOL_PROVIDERS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) =>
  response.json(),
);
const target =
  targets.find((item) => item.type === 'page' && item.url.includes('localhost:1420')) ?? targets[0];
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

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

// Account credentials and generated QA keys stay inside the WebView. Only
// account IDs, providers, status codes and sanitized diagnostics are returned.
const expression = `(async () => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error('tauri-internals-missing');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const representativeModel = (account) => {
    const enabled = account.models.filter((model) => model.enabled).map((model) => model.id);
    const preferred = {
      codex: ['gpt-5.4-mini', 'gpt-5.4'],
      gemini: ['gemini-2.5-flash'],
      antigravity: ['gemini-3-flash', 'claude-sonnet-4-6'],
      'claude-web': ['claude-haiku-4-5', 'claude-sonnet-5'],
      claude: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
      xai: ['grok-3-mini-fast', 'grok-3-mini'],
    }[account.provider] || [];
    return preferred.find((model) => enabled.includes(model)) || enabled[0] || '';
  };
  const request = async (url, key, model, timeoutMs = 60000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    try {
      const response = await fetch(url + '/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
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
      return {
        ok: response.ok,
        status: response.status,
        latencyMs: Math.round(performance.now() - started),
        diagnostic: String(diagnostic ?? '').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        latencyMs: Math.round(performance.now() - started),
        diagnostic: String(error?.message ?? error).slice(0, 500),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  let state = await invoke('multi_model_api_sync_managed_accounts');
  if (!state.running) state = await invoke('multi_model_api_set_enabled', { enabled: true });
  const originalConfig = structuredClone(state.config);
  const providerFilter = ${JSON.stringify(providerFilter)};
  const accounts = state.config.accounts.filter((account) =>
    account.enabled && (providerFilter.length === 0 || providerFilter.includes(account.provider))
  );
  const qaKeys = accounts.map((account, index) => {
    const model = representativeModel(account);
    return {
      id: 'qa-account-' + index + '-' + crypto.randomUUID(),
      label: 'QA scoped ' + account.provider + ' ' + (index + 1),
      key: 'sk-cle-qa-' + crypto.randomUUID().replaceAll('-', ''),
      allowedModels: model ? [model] : [],
      excludedModels: [],
      accountIds: [account.id],
      modelPrefix: '',
      providerGateway: null,
      source: 'qa:ephemeral-account-pool',
      enabled: true,
      account,
      model,
    };
  });
  const testConfig = structuredClone(state.config);
  testConfig.apiKeys = [
    ...testConfig.apiKeys,
    ...qaKeys.map(({ account, model, ...key }) => key),
  ];
  const results = [];
  let restoreError = null;
  try {
    state = await invoke('multi_model_api_save_config', { config: testConfig });
    for (const qa of qaKeys) {
      if (!qa.model) {
        results.push({
          accountId: qa.account.id,
          provider: qa.account.provider,
          model: '',
          ok: false,
          status: 0,
          latencyMs: 0,
          diagnostic: 'no enabled model',
        });
        continue;
      }
      const result = await request(state.baseUrl, qa.key, qa.model);
      results.push({
        accountId: qa.account.id,
        provider: qa.account.provider,
        model: qa.model,
        ...result,
      });
      await sleep(250);
    }
  } finally {
    try {
      await invoke('multi_model_api_save_config', { config: originalConfig });
    } catch (error) {
      restoreError = String(error?.message ?? error).slice(0, 500);
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    accountCount: accounts.length,
    successCount: results.filter((item) => item.ok).length,
    failureCount: results.filter((item) => !item.ok).length,
    restoreOk: restoreError === null,
    restoreError,
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
if (evaluated.exceptionDetails) {
  throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
}
const report = evaluated.result?.value;
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
