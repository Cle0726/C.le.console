import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, Check, CircleAlert, Copy, KeyRound, Plus, Power,
  RefreshCw, Route, Save, Server, Trash2, Users, X, Zap,
} from 'lucide-react';
import { ClaudeIcon } from '../components/icons/ClaudeIcon';
import { multiModelApiService } from '../services/multiModelApiService';
import type {
  MultiModelAccount, MultiModelApiConfig, MultiModelApiState, MultiModelApiTestResult,
} from '../types/multiModelApi';
import './MultiModelApiServicePage.css';
import './ClaudeWebApiPage.css';

type Tab = 'overview' | 'accounts' | 'routes';
type Notice = { tone: 'success' | 'error' | 'info'; text: string } | null;

const CLAUDE_MODELS = [
  { id: 'claude-opus-4-6', alias: '', capabilities: ['text', 'vision', 'reasoning'] as const, enabled: true },
  { id: 'claude-sonnet-4-6', alias: '', capabilities: ['text', 'vision', 'reasoning'] as const, enabled: true },
];

const newId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const newKey = () => `cle-mm-${Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
}

function navigate(page: string) {
  window.dispatchEvent(new CustomEvent('app-request-navigate', { detail: page }));
}

function defaultClaudeAccount(): MultiModelAccount {
  return {
    id: newId(),
    name: 'Anthropic API',
    provider: 'claude',
    authMode: 'api_key',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    credentialJson: null,
    proxyUrl: '',
    prefix: '',
    priority: 0,
    headers: {},
    models: CLAUDE_MODELS.map((model) => ({ ...model, capabilities: [...model.capabilities] })),
    enabled: true,
    source: 'manual',
  };
}

export function ClaudeWebApiPage() {
  const [state, setState] = useState<MultiModelApiState | null>(null);
  const [draft, setDraft] = useState<MultiModelApiConfig | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [operation, setOperation] = useState<string | null>('load');
  const [notice, setNotice] = useState<Notice>(null);
  const [copied, setCopied] = useState('');
  const [editing, setEditing] = useState<MultiModelAccount | null>(null);
  const [modelText, setModelText] = useState('claude-opus-4-6\nclaude-sonnet-4-6');
  const [testModel, setTestModel] = useState('claude-sonnet-4-6');
  const [testPrompt, setTestPrompt] = useState('Reply with exactly: claude-gateway-ok');
  const [testResult, setTestResult] = useState<MultiModelApiTestResult | null>(null);

  const load = useCallback(async (quiet = false) => {
    setOperation('load');
    if (!quiet) setNotice(null);
    try {
      const next = await multiModelApiService.getState();
      setState(next);
      setDraft(structuredClone(next.config));
    } catch (error) {
      setNotice({ tone: 'error', text: `读取 Claude API 服务失败：${String(error)}` });
    } finally {
      setOperation(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (next: MultiModelApiConfig, successText: string) => {
    setOperation('save');
    setNotice(null);
    try {
      const saved = await multiModelApiService.saveConfig(next);
      setState(saved);
      setDraft(structuredClone(saved.config));
      setNotice({ tone: 'success', text: successText });
      return saved;
    } catch (error) {
      setNotice({ tone: 'error', text: `保存失败：${String(error)}` });
      return null;
    } finally {
      setOperation(null);
    }
  };

  const toggle = async () => {
    if (!state || !draft) return;
    const claudeAccounts = draft.accounts.filter((item) => item.provider === 'claude' && item.enabled);
    if (!state.running && claudeAccounts.length === 0) {
      setTab('accounts');
      setNotice({ tone: 'error', text: '没有可用的 Claude OAuth / API Key 账号。请先同步账号或添加 Anthropic API Key。' });
      return;
    }
    setOperation('toggle');
    setNotice(null);
    try {
      const next = await multiModelApiService.setEnabled(!state.running);
      setState(next);
      setDraft(structuredClone(next.config));
      setNotice({ tone: 'success', text: next.running ? 'Claude API 代理已启动' : 'Claude API 代理已停止' });
    } catch (error) {
      setNotice({ tone: 'error', text: `服务操作失败：${String(error)}` });
      await load(true);
    } finally {
      setOperation(null);
    }
  };

  const syncClaude = async () => {
    setOperation('sync');
    setNotice(null);
    try {
      const next = await multiModelApiService.syncManagedAccounts();
      setState(next);
      setDraft(structuredClone(next.config));
      const count = next.config.accounts.filter((item) => item.provider === 'claude').length;
      setNotice({
        tone: count ? 'success' : 'info',
        text: count
          ? `已同步 ${count} 个 Claude OAuth / API Key 账号`
          : '没有发现可直接调用 API 的 Claude 凭证。Claude Desktop Cookie 登录态不等于 Anthropic API/OAuth 凭证，请导入 Claude Code OAuth 或 API Key。',
      });
    } catch (error) {
      setNotice({ tone: 'error', text: `同步 Claude 账号失败：${String(error)}` });
    } finally {
      setOperation(null);
    }
  };

  const openAccount = (account?: MultiModelAccount) => {
    const value = structuredClone(account ?? defaultClaudeAccount());
    setEditing(value);
    setModelText(value.models.map((model) => model.id).join('\n') || 'claude-opus-4-6\nclaude-sonnet-4-6');
  };

  const submitAccount = async () => {
    if (!draft || !editing) return;
    if (!editing.name.trim() || !editing.apiKey.trim()) {
      setNotice({ tone: 'error', text: '账号名称和 Anthropic API Key 不能为空' });
      return;
    }
    const modelIds = modelText.split('\n').map((item) => item.trim()).filter(Boolean);
    if (!modelIds.length) {
      setNotice({ tone: 'error', text: '至少配置一个 Claude 模型' });
      return;
    }
    const account: MultiModelAccount = {
      ...editing,
      provider: 'claude',
      authMode: 'api_key',
      models: modelIds.map((id) => ({ id, alias: '', capabilities: ['text', 'vision', 'reasoning'], enabled: true })),
    };
    const exists = draft.accounts.some((item) => item.id === account.id);
    const accounts = exists
      ? draft.accounts.map((item) => item.id === account.id ? account : item)
      : [...draft.accounts, account];
    const next = { ...draft, accounts };
    setEditing(null);
    setDraft(next);
    await save(next, exists ? 'Claude 账号已更新' : 'Claude API Key 账号已添加');
  };

  const updateAccount = async (account: MultiModelAccount) => {
    if (!draft) return;
    const next = { ...draft, accounts: draft.accounts.map((item) => item.id === account.id ? account : item) };
    setDraft(next);
    await save(next, account.enabled ? 'Claude 账号已启用' : 'Claude 账号已停用');
  };

  const removeAccount = async (account: MultiModelAccount) => {
    if (!draft || !window.confirm(`确定删除 Claude 账号“${account.name}”吗？`)) return;
    const next = { ...draft, accounts: draft.accounts.filter((item) => item.id !== account.id) };
    setDraft(next);
    await save(next, 'Claude 账号已删除');
  };

  const runTest = async () => {
    setOperation('test');
    setTestResult(null);
    setNotice(null);
    try {
      const result = await multiModelApiService.testChat(testModel, testPrompt);
      setTestResult(result);
      setNotice({ tone: result.ok ? 'success' : 'error', text: result.ok ? `Claude 网关测试成功 · ${result.latencyMs}ms` : `Claude 网关测试失败 · HTTP ${result.status}` });
    } catch (error) {
      setNotice({ tone: 'error', text: `Claude 网关测试失败：${String(error)}` });
    } finally {
      setOperation(null);
    }
  };

  const copy = async (value: string, id: string) => {
    await copyText(value);
    setCopied(id);
    window.setTimeout(() => setCopied(''), 1400);
  };

  const claudeAccounts = useMemo(() => draft?.accounts.filter((item) => item.provider === 'claude') ?? [], [draft]);
  const claudeModels = useMemo(() => new Set(claudeAccounts.filter((item) => item.enabled).flatMap((item) => item.models.filter((model) => model.enabled).map((model) => model.id))), [claudeAccounts]);

  if (!state || !draft) return <div className="mm-api-loading"><RefreshCw className="spin" />正在读取 Claude API 服务…</div>;
  const busy = operation !== null;
  const baseUrl = state.baseUrl.replace('0.0.0.0', '127.0.0.1');
  const apiKey = draft.apiKeys.find((item) => item.enabled)?.key ?? '';

  return <div className="mm-api-page claude-web-api-page">
    <div className="page-top-strip">
      <div className="page-top-strip-left"><span className="page-top-strip-label">Claude API</span></div>
      <div className="page-top-strip-right-placeholder" aria-hidden="true" />
    </div>
    <div className="page-tabs-row page-tabs-center page-tabs-row-with-leading mm-api-top-tabs">
      <div className="page-tabs-leading"><button type="button" className="claude-api-back" onClick={() => navigate('claude')}><ArrowLeft /><ClaudeIcon size={16} />Claude</button></div>
      <div className="page-tabs filter-tabs">
        {([['overview', Server, '服务'], ['accounts', Users, '账号'], ['routes', Route, '调用']] as const).map(([id, Icon, label]) => <button key={id} type="button" className={`filter-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}><Icon /><span>{label}</span></button>)}
      </div>
    </div>

    <main className="mm-api-content">
      <section className="mm-api-hero">
        <div className="mm-api-hero-main"><span className="mm-api-title-icon claude"><ClaudeIcon size={19} /></span><div className="mm-api-title-copy"><div className="mm-api-title-line"><h1>Claude API 代理服务</h1><span className={`mm-api-status ${state.running ? 'running' : 'stopped'}`}>{state.running ? '运行中' : '未运行'}</span><span className="claude-api-shared">统一网关内核</span></div><div className="mm-api-endpoint"><code>{baseUrl}/v1</code><button type="button" onClick={() => void copy(`${baseUrl}/v1`, 'url')}>{copied === 'url' ? <Check /> : <Copy />}</button></div></div></div>
        <div className="mm-api-hero-actions"><button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={busy}><RefreshCw className={operation === 'load' ? 'spin' : ''} />刷新</button><button type="button" className="btn btn-secondary" onClick={() => void runTest()} disabled={busy || !state.running || !claudeAccounts.some((item) => item.enabled)}><Zap />测试</button><button type="button" className={`btn ${state.running ? 'btn-danger' : 'btn-primary'}`} onClick={() => void toggle()} disabled={busy}><Power />{state.running ? '停止服务' : '启动服务'}</button></div>
      </section>

      {(notice || state.lastError) && <div className={`mm-api-message ${notice?.tone ?? 'error'}`}>{notice?.tone === 'success' ? <Check /> : <CircleAlert />}<span>{notice?.text ?? state.lastError}</span>{notice && <button type="button" onClick={() => setNotice(null)}><X /></button>}</div>}

      <section className="mm-api-summary-grid"><div className="mm-api-summary-card"><span>Claude 账号</span><strong>{claudeAccounts.filter((item) => item.enabled).length}</strong><small>OAuth / API Key</small></div><div className="mm-api-summary-card"><span>Claude 模型</span><strong>{claudeModels.size}</strong><small>账号实际声明</small></div><div className="mm-api-summary-card"><span>下游 Key</span><strong>{draft.apiKeys.filter((item) => item.enabled).length}</strong><small>OpenAI / Anthropic 协议</small></div><div className="mm-api-summary-card"><span>监听端口</span><strong>{draft.port}</strong><small>{draft.accessScope === 'lan' ? '局域网' : '仅本机'}</small></div></section>

      {tab === 'overview' && <div className="mm-api-grid two">
        <section className="mm-api-panel"><header className="mm-api-panel-head"><div><h2>Claude 网关配置</h2><p>使用 C.le. 中的 Claude Code OAuth 或 Anthropic-compatible API Key。</p></div><button type="button" className="btn btn-primary" onClick={() => void syncClaude()} disabled={busy}><RefreshCw className={operation === 'sync' ? 'spin' : ''} />同步 Claude</button></header><div className="claude-api-config-list"><label><span>Base URL</span><div><code>{baseUrl}</code><button type="button" onClick={() => void copy(baseUrl, 'base')}>{copied === 'base' ? <Check /> : <Copy />}</button></div></label><label><span>API Key</span><div><code>{apiKey || '尚未创建'}</code>{apiKey && <button type="button" onClick={() => void copy(apiKey, 'key')}>{copied === 'key' ? <Check /> : <Copy />}</button>}</div></label><label><span>Anthropic Endpoint</span><div><code>{baseUrl}/v1/messages</code><button type="button" onClick={() => void copy(`${baseUrl}/v1/messages`, 'messages')}>{copied === 'messages' ? <Check /> : <Copy />}</button></div></label></div>{!apiKey && <button type="button" className="btn btn-primary claude-api-create-key" onClick={() => { const next = { ...draft, apiKeys: [...draft.apiKeys, { id: newId(), label: 'Claude Gateway Key', key: newKey(), allowedModels: [], enabled: true }] }; setDraft(next); void save(next, 'Claude 网关 Key 已创建'); }}><KeyRound />创建下游 Key</button>}</section>
        <section className="mm-api-panel mm-test-panel"><header className="mm-api-panel-head"><div><h2>真实调用测试</h2><p>请求经过本地代理和账号路由，不是前端假响应。</p></div></header><label><span>Model ID</span><input value={testModel} onChange={(event) => setTestModel(event.target.value)} /></label><label><span>Prompt</span><textarea rows={5} value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} /></label><button type="button" className="btn btn-primary" onClick={() => void runTest()} disabled={busy || !state.running}><Zap />发送测试</button>{testResult && <div className={`mm-test-result ${testResult.ok ? 'success' : 'error'}`}><strong>HTTP {testResult.status} · {testResult.latencyMs}ms</strong><pre>{testResult.response || testResult.error}</pre></div>}</section>
      </div>}

      {tab === 'accounts' && <section className="mm-api-panel"><header className="mm-api-panel-head"><div><h2>Claude API 账号池</h2><p>Desktop Cookie 登录态不能直接转 API；这里使用 Claude Code OAuth 或 API Key。</p></div><div className="mm-inline-actions"><button type="button" className="btn btn-secondary" onClick={() => void syncClaude()} disabled={busy}><RefreshCw />同步 C.le. Claude</button><button type="button" className="btn btn-primary" onClick={() => openAccount()} disabled={busy}><Plus />添加 API Key</button></div></header><div className="mm-account-grid">{claudeAccounts.map((account) => <article className={`mm-account${account.enabled ? '' : ' disabled'}`} key={account.id}><div className="mm-account-top"><span className="mm-provider-icon claude"><ClaudeIcon size={18} /></span><div><h3>{account.name}</h3><p>{account.authMode === 'oauth_json' ? 'Claude Code OAuth' : 'Anthropic API Key'}</p></div><button type="button" className={`mm-account-state${account.enabled ? ' enabled' : ''}`} onClick={() => void updateAccount({ ...account, enabled: !account.enabled })}>{account.enabled ? '可用' : '停用'}</button></div><div className="mm-account-models"><strong>{account.models.length || '自动'} 个模型</strong></div><code>{account.baseUrl || 'Anthropic native endpoint'}</code><footer><span>{account.source.startsWith('cle:') ? 'C.le. 托管' : '手动添加'}</span>{account.authMode === 'api_key' && <button type="button" onClick={() => openAccount(account)}>编辑</button>}<button type="button" className="trash" onClick={() => void removeAccount(account)}><Trash2 /></button></footer></article>)}{!claudeAccounts.length && <div className="mm-empty"><ClaudeIcon size={32} /><h3>暂无可用 Claude API 凭证</h3><p>先同步 Claude Code OAuth，或者添加 Anthropic-compatible API Key。</p><div className="mm-inline-actions"><button type="button" className="btn btn-secondary" onClick={() => void syncClaude()}><RefreshCw />同步账号</button><button type="button" className="btn btn-primary" onClick={() => openAccount()}><Plus />添加 API Key</button></div></div>}</div></section>}

      {tab === 'routes' && <ClaudeRoutes baseUrl={baseUrl} apiKey={apiKey || 'YOUR_API_KEY'} copied={copied} copy={copy} />}
    </main>

    {editing && createPortal(<div className="mm-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setEditing(null)}><div className="mm-modal claude-api-account-modal" role="dialog" aria-modal="true"><header><div><h2>{draft.accounts.some((item) => item.id === editing.id) ? '编辑 Claude API Key' : '添加 Claude API Key'}</h2><p>支持 Anthropic 官方及兼容 Claude Messages API 的上游。</p></div><button type="button" onClick={() => setEditing(null)}><X /></button></header><div className="mm-modal-form"><label><span>账号名称</span><input autoFocus value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label><label><span>优先级</span><input type="number" value={editing.priority} onChange={(event) => setEditing({ ...editing, priority: Number(event.target.value) })} /></label><label className="wide"><span>Base URL</span><input value={editing.baseUrl} onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })} placeholder="https://api.anthropic.com" /></label><label className="wide"><span>Anthropic API Key</span><input type="password" value={editing.apiKey} onChange={(event) => setEditing({ ...editing, apiKey: event.target.value })} autoComplete="off" /></label><label className="wide"><span>模型 ID（每行一个）</span><textarea rows={6} value={modelText} onChange={(event) => setModelText(event.target.value)} /></label><label className="wide"><span>账号代理</span><input value={editing.proxyUrl} onChange={(event) => setEditing({ ...editing, proxyUrl: event.target.value })} placeholder="可选" /></label></div><footer><button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>取消</button><button type="button" className="btn btn-primary" onClick={() => void submitAccount()} disabled={busy}><Save />保存账号</button></footer></div></div>, document.body)}
  </div>;
}

function ClaudeRoutes({ baseUrl, apiKey, copied, copy }: { baseUrl: string; apiKey: string; copied: string; copy: (value: string, id: string) => Promise<void> }) {
  const routes = [
    { id: 'anthropic', method: 'POST', path: '/v1/messages', title: 'Anthropic Messages', code: `curl ${baseUrl}/v1/messages -H "x-api-key: ${apiKey}" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" -d '{"model":"claude-sonnet-4-6","max_tokens":128,"messages":[{"role":"user","content":"Hello"}]}'` },
    { id: 'openai', method: 'POST', path: '/v1/chat/completions', title: 'OpenAI Chat Completions', code: `curl ${baseUrl}/v1/chat/completions -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Hello"}]}'` },
    { id: 'models', method: 'GET', path: '/v1/models', title: '模型列表', code: `curl ${baseUrl}/v1/models -H "Authorization: Bearer ${apiKey}"` },
  ];
  return <section className="mm-api-panel"><header className="mm-api-panel-head"><div><h2>Claude 调用路线</h2><p>同时提供 Anthropic Messages 和 OpenAI-compatible Chat Completions。</p></div></header><div className="mm-route-grid">{routes.map((route) => <article className="mm-route" key={route.id}><header><span><Route /></span><div><h3>{route.title}</h3><code><b>{route.method}</b> {route.path}</code></div></header><pre>{route.code}</pre><button type="button" onClick={() => void copy(route.code, route.id)}>{copied === route.id ? <Check /> : <Copy />}{copied === route.id ? '已复制' : '复制 cURL'}</button></article>)}</div></section>;
}
