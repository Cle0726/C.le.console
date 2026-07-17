let snapshot = null;
const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const token = $('adminToken').value.trim();
  const response = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || text || `HTTP ${response.status}`);
  return payload;
}

async function refresh() {
  snapshot = await api('/admin/snapshot');
  render(snapshot);
}

async function testChat() {
  clearMessage();
  const response = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: snapshot.config.defaultModel, messages: [{ role: 'user', content: '你好，验证多平台反代' }], stream: false }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  showMessage('success', `反代成功：${payload.choices?.[0]?.message?.content || JSON.stringify(payload)}`);
  await refresh();
}

function render(data) {
  const { health, config, runtimeStates } = data;
  $('statusGrid').innerHTML = [
    pill('服务状态', health.ok ? '运行中' : '异常', health.ok ? 'ok' : 'bad'),
    pill('API Base URL', `http://${config.listenHost}:${config.listenPort}/v1`, 'muted', true),
    pill('默认模型', config.defaultModel, 'ok'),
    pill('Admin API', '/admin/snapshot', 'muted'),
  ].join('');

  $('statsGrid').innerHTML = [
    stat('平台数', config.providers.length),
    stat('账号数', config.accounts.length),
    stat('模型数', config.models.length),
    stat('运行态账号', runtimeStates.length),
  ].join('');

  renderProviders(config.providers);
  renderAccounts(config.accounts, runtimeStates);
  renderModels(config.models);
  renderRuntime(runtimeStates);
}

function renderProviders(items) {
  table('providersTable', ['状态', 'Provider', 'Kind', 'Base URL', '默认代理'], items.map((item) => [
    badge(item.enabled ? 'enabled' : 'disabled', item.enabled ? '启用' : '禁用'),
    `<strong>${esc(item.label)}</strong><br><code>${esc(item.id)}</code>`,
    `<code>${esc(item.kind)}</code>`,
    `<code>${esc(item.baseUrl || '—')}</code>`,
    `<code>${esc(item.defaultProxyId || 'direct')}</code>`,
  ]));
}

function renderAccounts(accounts, states) {
  const stateMap = new Map(states.map((item) => [item.accountId, item]));
  table('accountsTable', ['状态', '账号', 'Provider', '优先级', '调用/错误'], accounts.map((account) => {
    const state = stateMap.get(account.id);
    const status = state?.status || (account.enabled ? 'healthy' : 'disabled');
    return [
      badge(status, status),
      `<strong>${esc(account.label)}</strong><br><code>${esc(account.id)}</code>`,
      `<code>${esc(account.providerId)}</code>`,
      account.priority ?? 0,
      `<div class="runtime-stack"><span>today: ${state?.todayCalls ?? 0}</span><span>${esc(state?.lastFailureKind || '—')}</span></div>`,
    ];
  }));
}

function renderModels(items) {
  table('modelsTable', ['模型名', 'Capability', '策略', '直连 Provider', '候选链'], items.map((model) => [
    `<strong>${esc(model.id)}</strong>`,
    `<code>${esc(capabilityText(model.capabilities))}</code>`,
    `<code>${esc(model.strategy || 'round_robin')}</code>`,
    `<code>${esc(model.providerId || '—')} ${esc(model.upstreamModel || '')}</code>`,
    model.candidates?.length ? model.candidates.map((c) => `<code>${esc(c.providerId)}:${esc(c.model)}</code>`).join('<br>') : '—',
  ]));
}

function renderRuntime(items) {
  table('runtimeTable', ['账号', 'Provider', '状态', '今日调用', '最近成功', '最近错误'], items.map((item) => [
    `<code>${esc(item.accountId)}</code>`,
    `<code>${esc(item.providerId)}</code>`,
    badge(item.status, item.status),
    item.todayCalls ?? 0,
    esc(item.lastSuccessAt || '—'),
    `<pre>${esc(item.lastError || '—')}</pre>`,
  ]));
}

function table(id, headers, rows) {
  const empty = `<tr><td class="empty-cell" colspan="${headers.length}">暂无数据</td></tr>`;
  $(id).innerHTML = `<thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('') : empty}</tbody>`;
}

function pill(label, value, klass = 'muted', wide = false) { return `<div class="status-pill ${wide ? 'wide' : ''}"><span>${label}</span><strong class="${klass}">${esc(value)}</strong></div>`; }
function stat(label, value) { return `<article><span>${label}</span><strong>${esc(String(value))}</strong></article>`; }
function badge(klass, text) { return `<span class="badge ${esc(klass)}">${esc(text)}</span>`; }
function capabilityText(value) {
  return Array.isArray(value) && value.length ? value.map((item) => String(item)).join(', ') : 'chat';
}
function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch])); }
function showMessage(type, text) { $('messageBox').innerHTML = `<div class="callout ${type}">${esc(text)}</div>`; }
function clearMessage() { $('messageBox').innerHTML = ''; }

$('refreshBtn').addEventListener('click', () => refresh().catch((error) => showMessage('error', error.message)));
$('testBtn').addEventListener('click', () => testChat().catch((error) => showMessage('error', error.message)));
$('resetRuntimeBtn').addEventListener('click', () => api('/admin/runtime/reset', { method: 'POST', body: '{}' }).then(refresh).catch((error) => showMessage('error', error.message)));
refresh().catch((error) => showMessage('error', error.message));
