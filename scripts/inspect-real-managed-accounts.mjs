const cdpPort = Number(process.env.CLE_QA_CDP_PORT || 9225);
const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === 'page' && item.url.includes('localhost:1420')) ?? targets[0];
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

const expression = `(async () => {
  if (!window.__TAURI_INTERNALS__?.invoke) {
    return {
      error: 'tauri-internals-missing',
      readyState: document.readyState,
      title: document.title,
      bodyText: document.body?.innerText?.slice(0, 500),
      windowKeys: Object.keys(window).filter((key) => key.toLowerCase().includes('tauri')),
    };
  }
  const state = await window.__TAURI_INTERNALS__.invoke('multi_model_api_sync_managed_accounts');
  const accounts = state.config.accounts.map((account) => ({
    id: account.id,
    name: account.name,
    provider: account.provider,
    authMode: account.authMode,
    enabled: account.enabled,
    source: account.source,
    models: account.models.filter((model) => model.enabled).map((model) => ({
      id: model.id,
      capabilities: model.capabilities,
    })),
  }));
  return {
    running: state.running,
    baseUrl: state.baseUrl,
    downstreamKeyCount: state.config.apiKeys.filter((key) => key.enabled).length,
    accountCount: accounts.length,
    providers: Object.fromEntries([...new Set(accounts.map((account) => account.provider))].map((provider) => [provider, accounts.filter((account) => account.provider === provider).length])),
    uniqueModels: [...new Set(accounts.flatMap((account) => account.models.map((model) => model.id)))].sort(),
    accounts,
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
console.log(JSON.stringify(result.result?.value, null, 2));
