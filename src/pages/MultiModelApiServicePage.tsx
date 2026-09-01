import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  Boxes, Check, CircleAlert, Copy, Database, Download, Eye, EyeOff, FileText,
  FileUp, Film, Globe, Image, KeyRound, Network, Plus, Power, RefreshCw, Route,
  Save, Settings2, ShieldCheck, Sparkles, Trash2, Users, X, Zap,
} from 'lucide-react';
import { AntigravityIcon } from '../components/icons/AntigravityIcon';
import { ClaudeIcon } from '../components/icons/ClaudeIcon';
import { CodexIcon } from '../components/icons/CodexIcon';
import { GeminiIcon } from '../components/icons/GeminiIcon';
import * as accountService from '../services/accountService';
import * as claudeService from '../services/claudeService';
import * as codexService from '../services/codexService';
import * as geminiService from '../services/geminiService';
import { multiModelApiService } from '../services/multiModelApiService';
import type {
  ModelCapability, MultiModelAccount, MultiModelApiConfig, MultiModelApiState,
  MultiModelDefinition, MultiModelApiTestResult, MultiModelRepairReport, XaiAccountUsage,
} from '../types/multiModelApi';
import './MultiModelApiServicePage.css';

type Tab = 'overview' | 'accounts' | 'models' | 'keys' | 'routes';
type AccountAddMode = 'oauth' | 'token' | 'api_key' | 'import';
type Notice = { tone: 'success' | 'error' | 'info'; text: string } | null;

const PROVIDERS = [
  { id: 'xai', label: 'Grok / xAI', short: 'Grok', baseUrl: 'https://api.x.ai/v1' },
  { id: 'openai', label: 'OpenAI', short: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'claude', label: 'Claude', short: 'Claude', baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', label: 'Gemini', short: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'codex', label: 'Codex', short: 'Codex', baseUrl: '' },
  { id: 'antigravity', label: 'Antigravity', short: 'Antigravity', baseUrl: '' },
  { id: 'doubao-seedance', label: 'Doubao Seedance', short: 'Seedance', baseUrl: 'https://doubao.happieapi.top' },
  { id: 'custom', label: '兼容 API', short: '自定义', baseUrl: '' },
] as const;

const PROVIDER_MODELS: Record<string, MultiModelDefinition[]> = {
  xai: [
    ['grok-4.3', ['text', 'vision', 'reasoning']],
    ['grok-4.20-0309-reasoning', ['text', 'reasoning']],
    ['grok-4.20-0309-non-reasoning', ['text']],
    ['grok-4.20-multi-agent-0309', ['text', 'reasoning']],
    ['grok-3-mini-fast', ['text', 'reasoning']],
    ['grok-imagine-image', ['image']],
    ['grok-imagine-image-quality', ['image']],
    ['grok-imagine-video', ['video']],
  ].map(([id, capabilities]) => ({ id: id as string, alias: '', capabilities: capabilities as ModelCapability[], enabled: true })),
  antigravity: [
    ['claude-opus-4-6-thinking', ['text', 'vision', 'reasoning']],
    ['claude-sonnet-4-6', ['text', 'vision', 'reasoning']],
    ['gemini-3-pro-high', ['text', 'vision', 'reasoning']],
    ['gemini-3-flash', ['text', 'vision']],
    ['gemini-3.1-flash-image', ['text', 'vision', 'image']],
    ['veo-3.1-generate-preview', ['video']],
  ].map(([id, capabilities]) => ({ id: id as string, alias: '', capabilities: capabilities as ModelCapability[], enabled: true })),
  openai: [
    ['gpt-5.4', ['text', 'vision', 'reasoning']],
    ['gpt-5.4-mini', ['text', 'vision', 'reasoning']],
    ['gpt-image-2', ['image']],
  ].map(([id, capabilities]) => ({ id: id as string, alias: '', capabilities: capabilities as ModelCapability[], enabled: true })),
  claude: [
    ['claude-opus-4-6', ['text', 'vision', 'reasoning']],
    ['claude-sonnet-4-6', ['text', 'vision', 'reasoning']],
  ].map(([id, capabilities]) => ({ id: id as string, alias: '', capabilities: capabilities as ModelCapability[], enabled: true })),
  gemini: [
    ['gemini-3.1-pro-preview', ['text', 'vision', 'reasoning']],
    ['gemini-3-flash-preview', ['text', 'vision']],
    ['veo-3.1-generate-preview', ['video']],
    ['veo-3.0-generate-preview', ['video']],
  ].map(([id, capabilities]) => ({ id: id as string, alias: '', capabilities: capabilities as ModelCapability[], enabled: true })),
  codex: [
    ['gpt-5.4', ['text', 'vision', 'reasoning']],
    ['gpt-5.3-codex', ['text', 'vision', 'reasoning']],
  ].map(([id, capabilities]) => ({ id: id as string, alias: '', capabilities: capabilities as ModelCapability[], enabled: true })),
  'doubao-seedance': [
    ['doubao-seedance-1.5-pro', ['video']],
    ['doubao-seedance-1.0-pro-fast', ['video']],
  ].map(([id, capabilities]) => ({ id: id as string, alias: '', capabilities: capabilities as ModelCapability[], enabled: true })),
  custom: [],
};

const newId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const newKey = () => `cle-mm-${Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
const providerLabel = (id: string) => PROVIDERS.find((item) => item.id === id)?.label ?? id;
const accountModelsText = (models: MultiModelDefinition[]) => models
  .map((model) => `${model.id} | ${model.alias} | ${model.capabilities.join(',')}`)
  .join('\n');

const parseModels = (raw: string): MultiModelDefinition[] => raw.split('\n').map((line) => {
  const parts = line.split('|').map((item) => item.trim());
  const id = parts[0] ?? '';
  // Backward-compatible parsing: the previous editor emitted "id | capabilities"
  // when alias was empty, which accidentally stored capabilities as the alias.
  const alias = parts.length >= 3 ? (parts[1] ?? '') : '';
  const caps = parts.length >= 3 ? (parts[2] || 'text') : (parts[1] || 'text');
  const capabilities = caps.split(',').map((item) => item.trim()).filter(Boolean) as ModelCapability[];
  return {
    id,
    alias,
    capabilities: capabilities.length ? capabilities : (['text'] as ModelCapability[]),
    enabled: true,
  };
}).filter((item) => item.id);

function blankAccount(provider = 'xai'): MultiModelAccount {
  const preset = PROVIDERS.find((item) => item.id === provider) ?? PROVIDERS[0];
  return {
    id: newId(),
    name: '',
    provider,
    authMode: provider === 'antigravity' || provider === 'xai' ? 'oauth_json' : 'api_key',
    baseUrl: preset.baseUrl,
    apiKey: '',
    credentialJson: null,
    proxyUrl: '',
    prefix: '',
    priority: 0,
    headers: {},
    models: structuredClone(PROVIDER_MODELS[provider] ?? []),
    enabled: true,
    source: 'manual',
  };
}

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

export function MultiModelApiServicePage() {
  const [state, setState] = useState<MultiModelApiState | null>(null);
  const [draft, setDraft] = useState<MultiModelApiConfig | null>(null);
  const [tab, setTab] = useState<Tab>('accounts');
  const [operation, setOperation] = useState<string | null>('load');
  const [notice, setNotice] = useState<Notice>(null);
  const [copied, setCopied] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [editing, setEditing] = useState<MultiModelAccount | null>(null);
  const [editingIsNew, setEditingIsNew] = useState(false);
  const [modelText, setModelText] = useState('');
  const [credentialText, setCredentialText] = useState('');
  const [testModel, setTestModel] = useState('');
  const [testPrompt, setTestPrompt] = useState('Reply with exactly: gateway-ok');
  const [testResult, setTestResult] = useState<MultiModelApiTestResult | null>(null);
  const [repairReport, setRepairReport] = useState<MultiModelRepairReport | null>(null);

  const load = useCallback(async (quiet = false) => {
    setOperation('load');
    if (!quiet) setNotice(null);
    try {
      const next = await multiModelApiService.getState();
      setState(next);
      setDraft(structuredClone(next.config));
    } catch (error) {
      setNotice({ tone: 'error', text: `读取服务状态失败：${String(error)}` });
    } finally {
      setOperation(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const copy = async (value: string, id: string) => {
    try {
      await copyText(value);
      setCopied(id);
      window.setTimeout(() => setCopied(''), 1400);
    } catch (error) {
      setNotice({ tone: 'error', text: `复制失败：${String(error)}` });
    }
  };

  const save = async (next = draft, successText = '配置已保存并应用') => {
    if (!next) return null;
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
    if (!draft || !state) return;
    if (!state.running && !draft.accounts.some((item) => item.enabled)) {
      setTab('accounts');
      setNotice({ tone: 'error', text: '账号池为空。请先同步 C.le. 账号，或添加 Grok / OpenAI / Claude 等上游账号。' });
      return;
    }
    setOperation('toggle');
    setNotice(null);
    try {
      const next = await multiModelApiService.setEnabled(!state.running);
      setState(next);
      setDraft(structuredClone(next.config));
      setNotice({ tone: 'success', text: next.running ? '多模型 API 服务已启动' : '多模型 API 服务已停止' });
    } catch (error) {
      setNotice({ tone: 'error', text: `服务操作失败：${String(error)}` });
      await load(true);
    } finally {
      setOperation(null);
    }
  };

  const syncAccounts = async () => {
    setOperation('sync');
    setNotice(null);
    try {
      const next = await multiModelApiService.syncManagedAccounts();
      setState(next);
      setDraft(structuredClone(next.config));
      const managed = next.config.accounts.filter((item) => item.source.startsWith('cle:')).length;
      setNotice({
        tone: managed ? 'success' : 'info',
        text: managed ? `已同步 ${managed} 个可用于 API 网关的 C.le. 账号` : '没有发现可用的 C.le. OAuth / API Key 账号；桌面 Cookie 登录态不能直接作为 API 凭证。',
      });
    } catch (error) {
      setNotice({ tone: 'error', text: `同步失败：${String(error)}` });
    } finally {
      setOperation(null);
    }
  };

  const refreshXaiAccounts = async (forceCredentials = false) => {
    setOperation('xai-refresh');
    setNotice({ tone: 'info', text: forceCredentials ? '正在刷新 Grok 登录凭据与全部账号额度…' : '正在刷新 Grok 多账号额度…' });
    try {
      const next = await multiModelApiService.refreshXaiAccounts(forceCredentials);
      setState(next);
      setDraft(structuredClone(next.config));
      const healthy = (next.xaiAccounts ?? []).filter((item) => item.status === 'normal').length;
      setNotice({ tone: healthy ? 'success' : 'info', text: `Grok 账号刷新完成：${healthy}/${next.xaiAccounts?.length ?? 0} 个可用` });
    } catch (error) {
      setNotice({ tone: 'error', text: `刷新 Grok 账号失败：${String(error)}` });
    } finally {
      setOperation(null);
    }
  };

  const openAccount = (account?: MultiModelAccount, provider = 'xai') => {
    const value = structuredClone(account ?? blankAccount(provider));
    setEditing(value);
    setEditingIsNew(!account);
    setModelText(accountModelsText(value.models));
    setCredentialText(value.credentialJson ? JSON.stringify(value.credentialJson, null, 2) : '');
  };

  const changeProvider = (provider: string) => {
    if (!editing) return;
    const preset = PROVIDERS.find((item) => item.id === provider);
    const models = structuredClone(PROVIDER_MODELS[provider] ?? []);
    setEditing({
      ...editing,
      provider,
      authMode: provider === 'antigravity' || provider === 'xai' ? 'oauth_json' : 'api_key',
      baseUrl: preset?.baseUrl ?? '',
      models,
    });
    setModelText(accountModelsText(models));
    setCredentialText('');
  };

  const submitAccount = async (
    accountOverride?: MultiModelAccount,
    credentialTextOverride?: string,
  ) => {
    if (!draft || !editing) return;
    const current = accountOverride ?? editing;
    const currentCredentialText = credentialTextOverride ?? credentialText;
    if (!current.name.trim()) {
      setNotice({ tone: 'error', text: '请填写账号名称' });
      return;
    }
    if (current.authMode === 'api_key' && !current.apiKey.trim()) {
      setNotice({ tone: 'error', text: current.provider === 'doubao-seedance' ? '请填写 connect.sid / Cookie' : '请填写上游 API Key' });
      return;
    }
    if (current.provider === 'custom' && !current.baseUrl.trim()) {
      setNotice({ tone: 'error', text: '自定义兼容服务必须填写 Base URL' });
      return;
    }
    let credentialJson: Record<string, unknown> | null = null;
    if (current.authMode === 'oauth_json') {
      try {
        credentialJson = JSON.parse(currentCredentialText) as Record<string, unknown>;
      } catch {
        setNotice({ tone: 'error', text: 'OAuth credential 必须是合法 JSON' });
        return;
      }
    }
    const account = { ...current, credentialJson, models: parseModels(modelText) };
    const exists = draft.accounts.some((item) => item.id === account.id);
    const accounts = exists
      ? draft.accounts.map((item) => item.id === account.id ? account : item)
      : [...draft.accounts, account];
    const next = { ...draft, accounts };
    setEditing(null);
    setDraft(next);
    await save(next, exists ? '账号已更新' : `${providerLabel(account.provider)} 账号已添加`);
  };

  const updateAccount = async (account: MultiModelAccount) => {
    if (!draft) return;
    const next = { ...draft, accounts: draft.accounts.map((item) => item.id === account.id ? account : item) };
    setDraft(next);
    await save(next, account.enabled ? '账号已启用' : '账号已停用');
  };

  const removeAccount = async (account: MultiModelAccount) => {
    if (!draft || !window.confirm(`确定删除账号“${account.name}”吗？`)) return;
    const next = { ...draft, accounts: draft.accounts.filter((item) => item.id !== account.id) };
    setDraft(next);
    await save(next, '账号已删除');
  };

  const runTest = async () => {
    setOperation('test');
    setTestResult(null);
    setNotice(null);
    try {
      const result = await multiModelApiService.testChat(testModel.trim() || undefined, testPrompt.trim() || undefined);
      setTestResult(result);
      setNotice({
        tone: result.ok ? 'success' : 'error',
        text: result.ok ? `测试成功：${result.model} · ${result.latencyMs}ms` : `测试失败：HTTP ${result.status}`,
      });
    } catch (error) {
      setNotice({ tone: 'error', text: `网关测试失败：${String(error)}` });
    } finally {
      setOperation(null);
    }
  };

  const runRepair = async () => {
    setOperation('repair');
    setNotice({ tone: 'info', text: '正在检查配置、端口、sidecar、路由、模型目录与真实上游调用…' });
    try {
      const report = await multiModelApiService.diagnoseAndRepair(true);
      setRepairReport(report);
      setState(report.state);
      setDraft(structuredClone(report.state.config));
      setNotice({
        tone: report.ok ? 'success' : 'error',
        text: report.ok
          ? `全面检查完成：${report.checks.length} 项，自动修复 ${report.repaired} 项，耗时 ${report.durationMs}ms`
          : `检查完成但仍有 ${report.checks.filter((item) => item.status === 'error').length} 项需要处理`,
      });
    } catch (error) {
      setNotice({ tone: 'error', text: `全面检查与自动修复失败：${String(error)}` });
    } finally {
      setOperation(null);
    }
  };

  const accounts = draft?.accounts ?? [];
  const visibleAccounts = providerFilter === 'all' ? accounts : accounts.filter((item) => item.provider === providerFilter);
  const configuredProviders = useMemo(() => new Set(accounts.filter((item) => item.enabled).map((item) => item.provider)), [accounts]);
  const visibleCatalog = useMemo(() => {
    if (!state) return [];
    return providerFilter === 'all' ? state.catalog : state.catalog.filter((item) => item.provider === providerFilter);
  }, [providerFilter, state]);
  const availableModels = useMemo(() => new Set(accounts
    .filter((account) => account.enabled)
    .flatMap((account) => account.models.filter((model) => model.enabled).map((model) => model.alias || model.id))), [accounts]);
  const summary = useMemo(() => ({
    accounts: accounts.filter((item) => item.enabled).length,
    providers: configuredProviders.size,
    models: availableModels.size,
    keys: draft?.apiKeys.filter((item) => item.enabled).length ?? 0,
  }), [accounts, availableModels, configuredProviders, draft]);

  if (!draft || !state) {
    return <div className="mm-api-loading"><RefreshCw className="spin" />正在读取多模型网关状态…</div>;
  }

  const baseUrl = state.baseUrl.replace('0.0.0.0', '127.0.0.1');
  const firstKey = draft.apiKeys.find((item) => item.enabled)?.key ?? 'YOUR_API_KEY';
  const busy = operation !== null;

  return (
    <div className="mm-api-page">
      <div className="page-top-strip">
        <div className="page-top-strip-left">
          <span className="page-top-strip-label">API 服务</span>
        </div>
        <div className="page-top-strip-right-placeholder" aria-hidden="true" />
      </div>

      <div className="page-tabs-row page-tabs-center page-tabs-row-with-leading mm-api-top-tabs">
        <div className="page-tabs-leading">
          <div className="mm-api-context-label"><Network size={16} />多模型 API 代理</div>
        </div>
        <div className="page-tabs filter-tabs">
          {([
            ['overview', Settings2, '服务'], ['accounts', Users, '账号池'], ['models', Boxes, '模型'],
            ['keys', KeyRound, 'API Keys'], ['routes', Route, '路线'],
          ] as const).map(([id, Icon, label]) => (
            <button key={id} type="button" className={`filter-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
              <Icon /><span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      <main className="mm-api-content">
        <section className="mm-api-hero">
          <div className="mm-api-hero-main">
            <span className="mm-api-title-icon"><Network /></span>
            <div className="mm-api-title-copy">
              <div className="mm-api-title-line">
                <h1>多模型 API 代理服务</h1>
                <span className={`mm-api-status ${state.running ? 'running' : 'stopped'}`}>{state.running ? '运行中' : '未运行'}</span>
                {state.selfHeal && (
                  <span
                    className={`mm-api-status self-heal ${state.selfHeal.status}`}
                    title={`连续故障 ${state.selfHeal.consecutiveFailures} 次；自动恢复 ${state.selfHeal.restartAttempts} 次`}
                  >
                    自愈：{state.selfHeal.status === 'healthy' ? '正常' : state.selfHeal.status === 'recovering' ? '恢复中' : state.selfHeal.status === 'degraded' ? '降级' : '待监测'}
                  </span>
                )}
              </div>
              <div className="mm-api-endpoint">
                <code>{baseUrl}/v1</code>
                <button type="button" onClick={() => void copy(`${baseUrl}/v1`, 'url')} aria-label="复制 Base URL">
                  {copied === 'url' ? <Check /> : <Copy />}
                </button>
              </div>
            </div>
          </div>
          <div className="mm-api-hero-actions">
            <button type="button" className="btn btn-secondary mm-repair-trigger" onClick={() => void runRepair()} disabled={busy}>
              <ShieldCheck className={operation === 'repair' ? 'spin' : ''} />全面检查 / 自动修复
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={busy}>
              <RefreshCw className={operation === 'load' ? 'spin' : ''} />刷新
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => void runTest()} disabled={busy || !state.running}>
              <Zap className={operation === 'test' ? 'spin' : ''} />测试
            </button>
            <button type="button" className={`btn ${state.running ? 'btn-danger' : 'btn-primary'}`} onClick={() => void toggle()} disabled={busy}>
              <Power />{state.running ? '停止服务' : '启动服务'}
            </button>
          </div>
        </section>

        {(notice || state.lastError) && (
          <div className={`mm-api-message ${notice?.tone ?? 'error'}`}>
            {notice?.tone === 'success' ? <Check /> : <CircleAlert />}
            <span>{notice?.text ?? state.lastError}</span>
            {notice && <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示"><X /></button>}
          </div>
        )}

        {repairReport && (
          <RepairReportPanel report={repairReport} onClose={() => setRepairReport(null)} />
        )}

        <section className="mm-provider-strip" aria-label="模型供应商">
          <button type="button" className={providerFilter === 'all' ? 'active' : ''} onClick={() => setProviderFilter('all')}>
            <span className="mm-provider-icon all"><Network /></span>
            <b>全部</b><small>{summary.accounts} 个账号</small>
          </button>
          {PROVIDERS.map((provider) => {
            const count = accounts.filter((item) => item.provider === provider.id).length;
            return (
              <button key={provider.id} type="button" className={providerFilter === provider.id ? 'active' : ''} onClick={() => setProviderFilter(provider.id)}>
                <span className={`mm-provider-icon ${provider.id}`}><ProviderIcon provider={provider.id} /></span>
                <b>{provider.short}</b><small>{count ? `${count} 个账号` : '未配置'}</small>
              </button>
            );
          })}
        </section>

        <section className="mm-api-summary-grid">
          <Metric label="可用账号" value={summary.accounts} detail="按模型独立分流与故障转移" />
          <Metric label="已接入厂商" value={summary.providers} detail="按模型自动路由" />
          <Metric label="可调用模型" value={summary.models} detail="账号实际声明" />
          <Metric label="下游 Keys" value={summary.keys} detail="一个 Key 调全部" />
        </section>

        {tab === 'overview' && (
          <Overview config={draft} setConfig={setDraft} onSave={() => void save()} busy={busy} testModel={testModel} setTestModel={setTestModel} testPrompt={testPrompt} setTestPrompt={setTestPrompt} onTest={() => void runTest()} testResult={testResult} running={state.running} />
        )}

        {tab === 'accounts' && (
          <section className="mm-api-panel">
            <header className="mm-api-panel-head">
              <div><h2>{providerFilter === 'all' ? '多账号池' : `${providerLabel(providerFilter)} 账号`}</h2><p>同一模型按独立游标分流；有实时额度时优先健康额度带，并自动冷却、故障转移。</p></div>
              <div className="mm-inline-actions">
                {(providerFilter === 'all' || providerFilter === 'xai') && <button type="button" className="btn btn-secondary" onClick={() => void refreshXaiAccounts()} disabled={busy}><RefreshCw className={operation === 'xai-refresh' ? 'spin' : ''} />刷新 Grok 额度</button>}
                <button type="button" className="btn btn-secondary" onClick={() => void syncAccounts()} disabled={busy}><RefreshCw className={operation === 'sync' ? 'spin' : ''} />同步 C.le. 账号</button>
                <button type="button" className="btn btn-primary" onClick={() => openAccount(undefined, providerFilter === 'all' ? 'xai' : providerFilter)} disabled={busy}><Plus />添加账号</button>
              </div>
            </header>
            <div className="mm-account-grid">
              {visibleAccounts.map((account) => (
                <AccountCard key={account.id} account={account} xaiUsage={state.xaiAccounts?.find((item) => item.accountId === account.id)} onEdit={() => openAccount(account)} onToggle={() => void updateAccount({ ...account, enabled: !account.enabled })} onRemove={() => void removeAccount(account)} />
              ))}
              {!visibleAccounts.length && (
                <Empty icon={<Users />} title={providerFilter === 'all' ? '账号池还是空的' : `尚未配置 ${providerLabel(providerFilter)}`} text="同步已有 OAuth / API Key 账号，或手动添加上游凭证。">
                  <button type="button" className="btn btn-primary" onClick={() => openAccount(undefined, providerFilter === 'all' ? 'xai' : providerFilter)}><Plus />立即添加</button>
                </Empty>
              )}
            </div>
          </section>
        )}

        {tab === 'models' && (
          <section className="mm-api-panel">
            <header className="mm-api-panel-head"><div><h2>模型与能力目录</h2><p>“可用”表示已有启用账号声明该模型；未配置的模型不会被当成可调用额度。</p></div></header>
            <div className="mm-model-table">
              <div className="head"><span>厂商</span><span>Model ID</span><span>能力</span><span>状态 / 操作</span></div>
              {visibleCatalog.map((item) => {
                const configured = configuredProviders.has(item.provider);
                const available = availableModels.has(item.id) || configured;
                return (
                  <div className="row" key={`${item.provider}:${item.id}`}>
                    <span className={`provider ${item.provider}`}><ProviderIcon provider={item.provider} />{providerLabel(item.provider)}</span>
                    <code>{item.id}</code>
                    <span className="caps">{item.capabilities.map((cap) => <i key={cap}>{cap === 'image' ? <Image /> : cap === 'video' ? <Film /> : <Sparkles />}{cap}</i>)}</span>
                    <span className="mm-model-actions"><em className={available ? 'available' : ''}>{available ? '可用' : '未配置'}</em><button type="button" onClick={() => void copy(item.id, `model:${item.provider}:${item.id}`)}>{copied === `model:${item.provider}:${item.id}` ? <Check /> : <Copy />}</button>{!configured && <button type="button" onClick={() => { setTab('accounts'); setProviderFilter(item.provider); openAccount(undefined, item.provider); }}><Plus /></button>}</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {tab === 'keys' && (
          <section className="mm-api-panel">
            <header className="mm-api-panel-head"><div><h2>下游 API Keys</h2><p>模型白名单留空即允许调用账号池里的全部模型。</p></div><button type="button" className="btn btn-primary" onClick={() => { const next = { ...draft, apiKeys: [...draft.apiKeys, { id: newId(), label: `Key ${draft.apiKeys.length + 1}`, key: newKey(), allowedModels: [], enabled: true }] }; setDraft(next); void save(next, '新的下游 Key 已创建'); }} disabled={busy}><Plus />创建 Key</button></header>
            <div className="mm-key-list">
              {draft.apiKeys.map((item) => (
                <div className="mm-key" key={item.id}>
                  <label><input type="checkbox" checked={item.enabled} onChange={(event) => { const next = { ...draft, apiKeys: draft.apiKeys.map((key) => key.id === item.id ? { ...key, enabled: event.target.checked } : key) }; setDraft(next); void save(next, event.target.checked ? 'Key 已启用' : 'Key 已停用'); }} /><span><strong>{item.label}</strong><small>{item.allowedModels.length ? `${item.allowedModels.length} 个授权模型` : '全部模型'}</small></span></label>
                  <code>{item.key}</code>
                  <button type="button" onClick={() => void copy(item.key, item.id)} aria-label="复制 Key">{copied === item.id ? <Check /> : <Copy />}</button>
                  <button type="button" className="trash" onClick={() => { if (!window.confirm(`确定删除“${item.label}”吗？`)) return; const next = { ...draft, apiKeys: draft.apiKeys.filter((key) => key.id !== item.id) }; setDraft(next); void save(next, 'Key 已删除'); }} aria-label="删除 Key"><Trash2 /></button>
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === 'routes' && <Routes baseUrl={baseUrl} apiKey={firstKey} copied={copied} copy={copy} />}
      </main>

      {editing && createPortal(
        <AccountModal account={editing} isNew={editingIsNew} setAccount={setEditing} modelText={modelText} setModelText={setModelText} credentialText={credentialText} setCredentialText={setCredentialText} onProvider={changeProvider} onClose={() => setEditing(null)} onSubmit={(nextAccount, nextCredentialText) => void submitAccount(nextAccount, nextCredentialText)} onSyncManaged={syncAccounts} busy={busy} />,
        document.body,
      )}
    </div>
  );
}

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === 'xai') return <span className="mm-x-mark">𝕏</span>;
  if (provider === 'claude') return <ClaudeIcon size={18} />;
  if (provider === 'gemini') return <GeminiIcon style={{ width: 18, height: 18 }} />;
  if (provider === 'codex') return <CodexIcon size={18} />;
  if (provider === 'antigravity') return <AntigravityIcon style={{ width: 18, height: 18 }} />;
  if (provider === 'openai') return <Sparkles />;
  if (provider === 'doubao-seedance') return <Film />;
  return <Boxes />;
}

function Metric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <div className="mm-api-summary-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function RepairReportPanel({ report, onClose }: { report: MultiModelRepairReport; onClose: () => void }) {
  const errors = report.checks.filter((item) => item.status === 'error').length;
  const warnings = report.checks.filter((item) => item.status === 'warning').length;
  return (
    <section className={`mm-repair-report ${report.ok ? 'success' : 'has-error'}`} aria-live="polite">
      <header>
        <span className="mm-repair-report-icon"><ShieldCheck /></span>
        <div>
          <h2>{report.ok ? '系统检查通过' : '检查完成，仍有异常'}</h2>
          <p>{report.checks.length} 项检查 · 修复 {report.repaired} 项 · {errors} 个错误 · {warnings} 个警告 · {report.durationMs}ms</p>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭检查报告"><X /></button>
      </header>
      <div className="mm-repair-check-grid">
        {report.checks.map((item) => (
          <article key={item.id} className={`mm-repair-check ${item.status}`}>
            <span className="mm-repair-check-state">
              {item.status === 'ok' || item.status === 'repaired' ? <Check /> : <CircleAlert />}
            </span>
            <div><strong>{item.label}</strong><p>{item.detail}</p></div>
            {item.action && <em>{item.action}</em>}
          </article>
        ))}
      </div>
    </section>
  );
}

function Overview({ config, setConfig, onSave, busy, testModel, setTestModel, testPrompt, setTestPrompt, onTest, testResult, running }: {
  config: MultiModelApiConfig;
  setConfig: (value: MultiModelApiConfig) => void;
  onSave: () => void;
  busy: boolean;
  testModel: string;
  setTestModel: (value: string) => void;
  testPrompt: string;
  setTestPrompt: (value: string) => void;
  onTest: () => void;
  testResult: MultiModelApiTestResult | null;
  running: boolean;
}) {
  return <div className="mm-api-grid two">
    <section className="mm-api-panel">
      <header className="mm-api-panel-head"><div><h2>服务与调度设置</h2><p>保存后自动重启独立 sidecar，不影响原 Codex API 服务。</p></div><button type="button" className="btn btn-primary" disabled={busy} onClick={onSave}><Save />保存并应用</button></header>
      <div className="mm-form-grid">
        <label><span>监听端口</span><input type="number" min={1024} max={65535} value={config.port} onChange={(event) => setConfig({ ...config, port: Number(event.target.value) })} /><small>默认 1466</small></label>
        <label><span>访问范围</span><select value={config.accessScope} onChange={(event) => setConfig({ ...config, accessScope: event.target.value as 'localhost' | 'lan' })}><option value="localhost">仅本机 127.0.0.1</option><option value="lan">局域网 0.0.0.0</option></select><small>LAN 模式需要系统防火墙放行</small></label>
        <label><span>路由策略</span><select value={config.routingStrategy} onChange={(event) => setConfig({ ...config, routingStrategy: event.target.value as 'round-robin' | 'fill-first' })}><option value="round-robin">智能轮询（推荐）</option><option value="fill-first">Fill First 优先填满</option></select><small>每个模型独立轮询；自动避开明显低额度账号</small></label>
        <label><span>失败重试</span><input type="number" min={0} max={10} value={config.requestRetries} onChange={(event) => setConfig({ ...config, requestRetries: Number(event.target.value) })} /></label>
        <label className="wide"><span>上游代理</span><input placeholder="http://127.0.0.1:7890（可选）" value={config.upstreamProxy} onChange={(event) => setConfig({ ...config, upstreamProxy: event.target.value })} /></label>
        <label className="switch-row"><span><b>会话固定（默认关闭）</b><small>开启后同一会话会固定一个账号，可能造成单号集中消耗</small></span><input type="checkbox" checked={config.sessionAffinity} onChange={(event) => setConfig({ ...config, sessionAffinity: event.target.checked })} /></label>
        <label className="switch-row"><span><b>Debug Logs</b><small>记录 sidecar 请求诊断信息</small></span><input type="checkbox" checked={config.debugLogs} onChange={(event) => setConfig({ ...config, debugLogs: event.target.checked })} /></label>
      </div>
    </section>
    <section className="mm-api-panel mm-test-panel">
      <header className="mm-api-panel-head"><div><h2>真实网关测试</h2><p>从本机网关发起非流式 Chat Completions 请求。</p></div></header>
      <label><span>Model ID</span><input value={testModel} onChange={(event) => setTestModel(event.target.value)} placeholder="留空自动选择账号模型" /></label>
      <label><span>Prompt</span><textarea rows={5} value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} /></label>
      <button type="button" className="btn btn-primary" onClick={onTest} disabled={busy || !running}><Zap />发送测试</button>
      {testResult && <div className={`mm-test-result ${testResult.ok ? 'success' : 'error'}`}><strong>HTTP {testResult.status} · {testResult.latencyMs}ms · {testResult.model}</strong><pre>{testResult.response || testResult.error}</pre></div>}
    </section>
  </div>;
}

function formatQuotaNumber(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return '-';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function AccountCard({ account, xaiUsage, onEdit, onToggle, onRemove }: { account: MultiModelAccount; xaiUsage?: XaiAccountUsage; onEdit: () => void; onToggle: () => void; onRemove: () => void }) {
  const capabilities = new Set(account.models.flatMap((item) => item.capabilities));
  return <article className={`mm-account${account.enabled ? '' : ' disabled'}`}>
    <div className="mm-account-top"><span className={`mm-provider-icon ${account.provider}`}><ProviderIcon provider={account.provider} /></span><div><h3>{xaiUsage?.email || account.name}</h3><p>{providerLabel(account.provider)} · {account.provider === 'doubao-seedance' ? 'connect.sid' : account.authMode === 'oauth_json' ? 'OAuth' : 'API Key'}{xaiUsage?.plan ? ` · ${xaiUsage.plan}` : ''}</p></div><button type="button" className={`mm-account-state${account.enabled && (!xaiUsage || xaiUsage.status === 'normal') ? ' enabled' : ''}`} onClick={onToggle}>{!account.enabled ? '停用' : xaiUsage?.status === 'reauth_required' ? '需重登' : xaiUsage?.status === 'error' ? '异常' : '可用'}</button></div>
    {account.provider === 'xai' && account.authMode === 'oauth_json' && <div className="mm-xai-quota">
      {xaiUsage?.buckets?.length ? xaiUsage.buckets.slice(0, 4).map((bucket) => {
        const usedPercent = Math.max(0, Math.min(100, bucket.usedPercent ?? (bucket.used != null && bucket.total ? bucket.used / bucket.total * 100 : 0)));
        return <div className="mm-xai-quota-row" key={bucket.id} title={bucket.resetAt ? `重置：${new Date(bucket.resetAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : undefined}>
          <span><b>{bucket.label}</b><em>{bucket.remaining != null && bucket.total != null ? `剩 ${formatQuotaNumber(bucket.remaining)} / ${formatQuotaNumber(bucket.total)}` : `${formatQuotaNumber(100 - usedPercent)}% 可用`}</em></span>
          <i><u style={{ width: `${100 - usedPercent}%` }} /></i>
        </div>;
      }) : <p className={xaiUsage?.status === 'error' || xaiUsage?.status === 'reauth_required' ? 'error' : ''}>{xaiUsage?.statusReason || '额度尚未刷新'}</p>}
      {xaiUsage?.hasGrokCodeAccess != null && <small>Grok Code：{xaiUsage.hasGrokCodeAccess ? '可用' : '未开通'}</small>}
    </div>}
    <div className="mm-account-models"><strong>{account.models.length || '自动'} 个模型</strong><span>{[...capabilities].map((cap) => <em key={cap}>{cap}</em>)}</span></div>
    <code>{account.baseUrl || 'CLIProxy native endpoint'}</code>
    <footer><span>{account.source.startsWith('cle:') ? 'C.le. 托管账号' : account.source.startsWith('grok:local:') ? 'Grok CLI 本机导入' : account.source === 'grok:device-oauth' ? 'xAI 官方 Device Flow' : account.source === 'grok:json-import' ? 'Grok OAuth JSON 导入' : '手动账号'}</span><button type="button" onClick={onEdit}>编辑</button><button type="button" className="trash" onClick={onRemove} aria-label="删除账号"><Trash2 /></button></footer>
  </article>;
}

function Empty({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children?: ReactNode }) {
  return <div className="mm-empty">{icon}<h3>{title}</h3><p>{text}</p>{children}</div>;
}

function initialAccountAddMode(account: MultiModelAccount): AccountAddMode {
  if (account.provider === 'codex' || account.provider === 'xai') return account.authMode === 'api_key' ? 'api_key' : 'oauth';
  return account.authMode === 'oauth_json' ? 'token' : 'api_key';
}

type GenericOAuthDraft = {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  redirectUri: string;
  extraAuthorizeParams: string;
  extraTokenParams: string;
  state: string;
  codeVerifier: string;
};

function defaultGenericOAuthDraft(provider: string): GenericOAuthDraft {
  const normalized = provider === 'custom' ? '' : provider;
  if (normalized === 'xai') {
    return {
      authorizationUrl: 'https://auth.x.ai/oauth2/authorize',
      tokenUrl: 'https://auth.x.ai/oauth2/token',
      clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
      clientSecret: '',
      scope: 'openid profile email offline_access grok-cli:access api:access',
      redirectUri: 'http://127.0.0.1:56121/callback',
      extraAuthorizeParams: 'nonce=__GENERATED_NONCE__\nplan=generic\nreferrer=cli-proxy-api',
      extraTokenParams: '',
      state: '',
      codeVerifier: '',
    };
  }
  return {
    authorizationUrl: '',
    tokenUrl: '',
    clientId: '',
    clientSecret: '',
    scope: normalized === 'openai' || normalized === 'xai' ? 'openid profile email offline_access' : '',
    redirectUri: 'http://127.0.0.1:1455/auth/callback',
    extraAuthorizeParams: '',
    extraTokenParams: '',
    state: '',
    codeVerifier: '',
  };
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readPendingOAuthCredential(value?: Record<string, unknown> | null) {
  if (!value || value.status !== 'oauth_pending') return null;
  return {
    provider: stringField(value.provider || value.type),
    email: stringField(value.email),
    authUrl: stringField(value.auth_url || value.authUrl),
    state: stringField(value.state),
    codeVerifier: stringField(value.code_verifier || value.codeVerifier),
    redirectUri: stringField(value.redirect_uri || value.redirectUri),
    tokenUrl: stringField(value.token_url || value.tokenUrl),
    clientId: stringField(value.client_id || value.clientId),
    scope: stringField(value.scope),
  };
}

function parseKeyValueLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=') >= 0 ? line.indexOf('=') : line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function AccountModal({ account, isNew, setAccount, modelText, setModelText, credentialText, setCredentialText, onProvider, onClose, onSubmit, onSyncManaged, busy }: {
  account: MultiModelAccount;
  isNew: boolean;
  setAccount: (value: MultiModelAccount) => void;
  modelText: string;
  setModelText: (value: string) => void;
  credentialText: string;
  setCredentialText: (value: string) => void;
  onProvider: (value: string) => void;
  onClose: () => void;
  onSubmit: (account?: MultiModelAccount, credentialText?: string) => void | Promise<void>;
  onSyncManaged: () => Promise<void>;
  busy: boolean;
}) {
  const [addMode, setAddMode] = useState<AccountAddMode>(() => initialAccountAddMode(account));
  const [localBusy, setLocalBusy] = useState(false);
  const [secretVisible, setSecretVisible] = useState(false);
  const [modalStatus, setModalStatus] = useState<{ tone: 'success' | 'error' | 'info' | 'loading'; text: string } | null>(null);
  const [oauthUrl, setOauthUrl] = useState('');
  const [xaiUserCode, setXaiUserCode] = useState('');
  const [oauthUrlCopied, setOauthUrlCopied] = useState(false);
  const [oauthCallbackInput, setOauthCallbackInput] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [claudeEmailHint, setClaudeEmailHint] = useState('');
  const [genericDraft, setGenericDraft] = useState<GenericOAuthDraft>(() => defaultGenericOAuthDraft(account.provider));
  const oauthLoginIdRef = useRef<string | null>(null);
  const oauthProviderRef = useRef<string | null>(null);
  const isCodex = account.provider === 'codex';
  const isGemini = account.provider === 'gemini';
  const isClaude = account.provider === 'claude';
  const isAntigravity = account.provider === 'antigravity';
  const isXai = account.provider === 'xai';
  const isSeedance = account.provider === 'doubao-seedance';
  const hasNativeOAuth = isCodex || isGemini || isClaude || isAntigravity || isXai;
  const disabled = busy || localBusy;

  const cancelActiveOAuth = useCallback(() => {
    const provider = oauthProviderRef.current;
    const loginId = oauthLoginIdRef.current;
    if (provider === 'codex' && loginId) codexService.cancelCodexOAuthLogin(loginId).catch(() => {});
    if (provider === 'gemini' && loginId) geminiService.cancelGeminiOAuthLogin(loginId).catch(() => {});
    if (provider === 'claude' && loginId) claudeService.claudeOauthLoginCancel(loginId).catch(() => {});
    if (provider === 'antigravity') accountService.cancelOAuthLogin().catch(() => {});
    if (provider === 'xai') multiModelApiService.cancelXaiOAuth(loginId).catch(() => {});
    oauthLoginIdRef.current = null;
    oauthProviderRef.current = null;
  }, []);

  useEffect(() => {
    const pending = readPendingOAuthCredential(account.credentialJson);
    const draft = defaultGenericOAuthDraft(account.provider);
    setModalStatus(null);
    setOauthUrl(pending?.provider === account.provider ? pending.authUrl : '');
    setXaiUserCode('');
    setOauthCallbackInput('');
    setPendingEmail(pending?.provider === account.provider ? pending.email : '');
    setGenericDraft(pending?.provider === account.provider ? {
      ...draft,
      tokenUrl: pending.tokenUrl || draft.tokenUrl,
      clientId: pending.clientId || draft.clientId,
      scope: pending.scope || draft.scope,
      redirectUri: pending.redirectUri || draft.redirectUri,
      state: pending.state,
      codeVerifier: pending.codeVerifier,
    } : draft);
    cancelActiveOAuth();
    if (pending?.provider === account.provider && pending.authUrl) oauthProviderRef.current = account.provider;
    if (isSeedance) {
      setAddMode('api_key');
    } else if (isNew && (account.provider === 'xai' || account.provider === 'codex' || account.provider === 'gemini' || account.provider === 'claude' || account.provider === 'antigravity')) {
      setAddMode('oauth');
    }
  }, [account.credentialJson, account.provider, cancelActiveOAuth, isNew, isSeedance]);

  useEffect(() => () => cancelActiveOAuth(), [cancelActiveOAuth]);

  const finishManagedImport = useCallback(async (successText: string) => {
    setLocalBusy(true);
    setModalStatus({ tone: 'loading', text: '正在同步到多模型 API 账号池...' });
    try {
      await onSyncManaged();
      setModalStatus({ tone: 'success', text: successText });
      window.setTimeout(onClose, 850);
    } catch (error) {
      setModalStatus({ tone: 'error', text: `同步失败：${String(error).replace(/^Error:\s*/, '')}` });
    } finally {
      setLocalBusy(false);
    }
  }, [onClose, onSyncManaged]);

  const startNativeOauth = useCallback(async (force = false) => {
    if (!hasNativeOAuth || addMode !== 'oauth') return;
    if (!force && (oauthProviderRef.current || oauthUrl)) return;
    if (force) {
      cancelActiveOAuth();
      setOauthUrl('');
      setOauthCallbackInput('');
    }
    setLocalBusy(true);
    setModalStatus({ tone: 'loading', text: `正在准备 ${providerLabel(account.provider)} OAuth 授权链接...` });
    try {
      if (isCodex) {
        const login = await codexService.startCodexOAuthLogin();
        oauthProviderRef.current = 'codex';
        oauthLoginIdRef.current = login.loginId || null;
        setOauthUrl(login.authUrl || '');
        setModalStatus(null);
      } else if (isGemini) {
        const login = await geminiService.startGeminiOAuthLogin();
        oauthProviderRef.current = 'gemini';
        oauthLoginIdRef.current = login.loginId || null;
        setOauthUrl(login.verificationUri || login.callbackUrl || '');
        setModalStatus({ tone: 'info', text: 'Gemini OAuth 已启动；浏览器授权完成后会自动同步，也可以手动粘贴回调地址。' });
        void (async () => {
          try {
            await geminiService.completeGeminiOAuthLogin(login.loginId);
            oauthLoginIdRef.current = null;
            oauthProviderRef.current = null;
            setOauthUrl('');
            await finishManagedImport('Gemini OAuth 账号已导入 API 代理账号池');
          } catch (error) {
            if (oauthProviderRef.current === 'gemini') {
              setModalStatus({ tone: 'error', text: `Gemini OAuth 授权失败：${String(error).replace(/^Error:\s*/, '')}` });
            }
          }
        })();
      } else if (isClaude) {
        const login = await claudeService.claudeOauthLoginStart();
        oauthProviderRef.current = 'claude';
        oauthLoginIdRef.current = login.loginId || null;
        setOauthUrl(login.verificationUri || '');
        setModalStatus({ tone: 'info', text: 'Claude OAuth 已启动；打开授权链接后，把页面返回的 code 或完整回调地址粘贴回来。' });
      } else if (isAntigravity) {
        const url = await accountService.prepareOAuthUrl();
        oauthProviderRef.current = 'antigravity';
        oauthLoginIdRef.current = null;
        setOauthUrl(url || '');
        setModalStatus({ tone: 'info', text: 'Antigravity OAuth 已启动；授权完成后点“我已授权，继续”，或粘贴完整回调地址。' });
      } else if (isXai) {
        const response = await multiModelApiService.startXaiOAuth();
        oauthProviderRef.current = 'xai';
        oauthLoginIdRef.current = response.loginId;
        setXaiUserCode(response.userCode);
        setOauthUrl(response.verificationUriComplete || response.verificationUri);
        setModalStatus({ tone: 'info', text: `Grok / xAI 官方 Device Flow 已启动；验证码 ${response.userCode}，浏览器确认后点“我已授权，继续”。` });
      }
    } catch (error) {
      setModalStatus({ tone: 'error', text: `准备 OAuth 授权失败：${String(error).replace(/^Error:\s*/, '')}` });
    } finally {
      setLocalBusy(false);
    }
  }, [account.provider, addMode, cancelActiveOAuth, finishManagedImport, hasNativeOAuth, isAntigravity, isClaude, isCodex, isGemini, isXai, oauthUrl]);

  useEffect(() => {
    if (!hasNativeOAuth || addMode !== 'oauth') return;
    if (!oauthUrl && !localBusy) void startNativeOauth();
  }, [addMode, hasNativeOAuth, localBusy, oauthUrl, startNativeOauth]);

  useEffect(() => {
    if (addMode === 'oauth') return;
    setOauthUrl('');
    setOauthCallbackInput('');
    cancelActiveOAuth();
  }, [addMode, cancelActiveOAuth]);

  const completeCodexOauth = useCallback(async (loginId: string) => {
    setLocalBusy(true);
    setModalStatus({ tone: 'loading', text: '正在交换令牌并保存 Codex 账号...' });
    try {
      await codexService.completeCodexOAuthLogin(loginId, null);
      oauthLoginIdRef.current = null;
      oauthProviderRef.current = null;
      setOauthUrl('');
      await finishManagedImport('Codex OAuth 账号已导入 API 代理账号池');
    } catch (error) {
      setModalStatus({ tone: 'error', text: `OAuth 授权失败：${String(error).replace(/^Error:\s*/, '')}` });
    } finally {
      setLocalBusy(false);
    }
  }, [finishManagedImport]);

  useEffect(() => {
    if (!isCodex) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    listen<{ loginId?: string }>('codex-oauth-login-completed', (event) => {
      if (disposed || addMode !== 'oauth') return;
      const loginId = event.payload?.loginId;
      if (!loginId) return;
      if (oauthLoginIdRef.current && oauthLoginIdRef.current !== loginId) return;
      void completeCodexOauth(loginId);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    }).catch((error) => {
      setModalStatus({ tone: 'error', text: `监听 OAuth 回调失败：${String(error).replace(/^Error:\s*/, '')}` });
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addMode, completeCodexOauth, isCodex]);

  const handleCopyOauthUrl = async () => {
    if (!oauthUrl) return;
    await copyText(oauthUrl);
    setOauthUrlCopied(true);
    window.setTimeout(() => setOauthUrlCopied(false), 1200);
  };

  const handleOpenOauthUrl = async () => {
    if (!oauthUrl) return;
    try {
      await openUrl(oauthUrl);
    } catch {
      await handleCopyOauthUrl();
    }
  };

  const handleSubmitOauthCallback = async () => {
    const loginId = oauthLoginIdRef.current;
    const callbackUrl = oauthCallbackInput.trim();
    const provider = oauthProviderRef.current;
    if (!provider) return;
    if (!callbackUrl && provider !== 'antigravity' && provider !== 'xai') return;
    setLocalBusy(true);
    setModalStatus({ tone: 'loading', text: '正在提交 OAuth 回调并交换令牌...' });
    try {
      if (provider === 'codex') {
        if (!loginId) throw new Error('Codex OAuth 会话不存在，请重新生成授权链接');
        await codexService.submitCodexOAuthCallbackUrl(loginId, callbackUrl);
        await completeCodexOauth(loginId);
        return;
      }
      if (provider === 'gemini') {
        if (!loginId) throw new Error('Gemini OAuth 会话不存在，请重新生成授权链接');
        if (callbackUrl) await geminiService.submitGeminiOAuthCallbackUrl(loginId, callbackUrl);
        await geminiService.completeGeminiOAuthLogin(loginId);
        oauthLoginIdRef.current = null;
        oauthProviderRef.current = null;
        await finishManagedImport('Gemini OAuth 账号已导入 API 代理账号池');
        return;
      }
      if (provider === 'claude') {
        if (!loginId) throw new Error('Claude OAuth 会话不存在，请重新生成授权链接');
        await claudeService.claudeOauthLoginComplete(loginId, callbackUrl, claudeEmailHint || account.name);
        oauthLoginIdRef.current = null;
        oauthProviderRef.current = null;
        await finishManagedImport('Claude OAuth 账号已导入 API 代理账号池');
        return;
      }
      if (provider === 'antigravity') {
        if (callbackUrl) await accountService.submitOAuthCallbackUrl(callbackUrl);
        await accountService.completeOAuthLogin();
        oauthLoginIdRef.current = null;
        oauthProviderRef.current = null;
        await finishManagedImport('Antigravity OAuth 账号已导入 API 代理账号池');
        return;
      }
      if (provider === 'xai') {
        if (!loginId) throw new Error('Grok / xAI Device Flow 会话不存在，请重新生成授权链接');
        await multiModelApiService.completeXaiOAuth(loginId);
        oauthLoginIdRef.current = null;
        oauthProviderRef.current = null;
        await finishManagedImport('Grok / xAI OAuth 账号已导入 API 账号池并完成额度检测');
        return;
      }
    } catch (error) {
      setModalStatus({ tone: 'error', text: `OAuth 授权失败：${String(error).replace(/^Error:\s*/, '')}` });
    } finally {
      setLocalBusy(false);
    }
  };

  const handleSavePendingNativeOAuth = async () => {
    if (!isXai) {
      await handleSavePendingCodexOAuth();
      return;
    }
    const email = pendingEmail.trim();
    if (!email) {
      setModalStatus({ tone: 'error', text: '请输入待授权 Grok / xAI 账号邮箱' });
      return;
    }
    if (!oauthUrl || !oauthLoginIdRef.current) {
      setModalStatus({ tone: 'error', text: '请先生成 Grok / xAI OAuth 授权链接' });
      return;
    }
    const name = account.name.trim() || `Grok / xAI ${email}`;
    const credentialJson = JSON.stringify({
      type: 'xai',
      provider: 'xai',
      status: 'oauth_pending',
      email,
      auth_url: oauthUrl,
      login_id: oauthLoginIdRef.current,
      user_code: xaiUserCode,
      created_at: new Date().toISOString(),
    }, null, 2);
    await onSubmit({
      ...account,
      name,
      authMode: 'oauth_json',
      apiKey: '',
      enabled: false,
      source: 'manual:oauth_pending',
    }, credentialJson);
  };

  const handleSavePendingCodexOAuth = async () => {
    const email = pendingEmail.trim();
    if (!email) {
      setModalStatus({ tone: 'error', text: '请输入待授权 OpenAI 账号邮箱' });
      return;
    }
    setLocalBusy(true);
    setModalStatus({ tone: 'loading', text: '正在保存待授权卡片...' });
    try {
      await codexService.createPendingCodexOAuthAccount(email, {});
      await onSyncManaged();
      setModalStatus({ tone: 'success', text: '待授权卡片已保存；完成授权后会自动进入可用账号池' });
      window.setTimeout(onClose, 850);
    } catch (error) {
      setModalStatus({ tone: 'error', text: `保存待授权卡片失败：${String(error).replace(/^Error:\s*/, '')}` });
    } finally {
      setLocalBusy(false);
    }
  };

  const handleGenericOAuthStart = async () => {
    setLocalBusy(true);
    setModalStatus({ tone: 'loading', text: '正在生成通用 OAuth2 / PKCE 授权链接...' });
    try {
      const response = await multiModelApiService.genericOAuthStart({
        authorizationUrl: genericDraft.authorizationUrl,
        clientId: genericDraft.clientId,
        redirectUri: genericDraft.redirectUri,
        scope: genericDraft.scope,
        extraAuthorizeParams: parseKeyValueLines(genericDraft.extraAuthorizeParams),
      });
      setGenericDraft((draft) => ({ ...draft, state: response.state, codeVerifier: response.codeVerifier }));
      setOauthUrl(response.authUrl);
      setModalStatus({ tone: 'info', text: '授权链接已生成；在浏览器授权后，把完整回调地址或 code 粘贴回来。' });
    } catch (error) {
      setModalStatus({ tone: 'error', text: `生成 OAuth 链接失败：${String(error).replace(/^Error:\s*/, '')}` });
    } finally {
      setLocalBusy(false);
    }
  };

  const handleGenericOAuthExchange = async () => {
    const callbackOrCode = oauthCallbackInput.trim();
    if (!callbackOrCode) {
      setModalStatus({ tone: 'error', text: '请粘贴 OAuth 回调地址或 code' });
      return;
    }
    setLocalBusy(true);
    setModalStatus({ tone: 'loading', text: '正在交换 OAuth token 并保存到账号池...' });
    try {
      const credential = await multiModelApiService.genericOAuthExchange({
        provider: account.provider,
        tokenUrl: genericDraft.tokenUrl,
        clientId: genericDraft.clientId,
        clientSecret: genericDraft.clientSecret,
        redirectUri: genericDraft.redirectUri,
        callbackOrCode,
        codeVerifier: genericDraft.codeVerifier,
        expectedState: genericDraft.state,
        extraTokenParams: parseKeyValueLines(genericDraft.extraTokenParams),
      });
      const credentialJson = JSON.stringify(credential, null, 2);
      setCredentialText(credentialJson);
      await onSubmit({ ...account, authMode: 'oauth_json', apiKey: '' }, credentialJson);
    } catch (error) {
      setModalStatus({ tone: 'error', text: `OAuth token 交换失败：${String(error).replace(/^Error:\s*/, '')}` });
    } finally {
      setLocalBusy(false);
    }
  };

  const handleApiKeySubmit = async () => {
    const apiKey = account.apiKey.trim();
    if (!apiKey) {
      setModalStatus({ tone: 'error', text: isSeedance ? '请填写 connect.sid / Cookie' : '请填写 API Key' });
      return;
    }
    if (!isCodex && !isClaude) {
      await onSubmit({ ...account, authMode: 'api_key', credentialJson: null }, credentialText);
      return;
    }
    if (isClaude) {
      setLocalBusy(true);
      setModalStatus({ tone: 'loading', text: '正在按 Claude API Key 账号方式保存...' });
      try {
        const models = parseModels(modelText);
        await claudeService.importClaudeApiKey(apiKey, account.name.trim() || undefined, {
          apiBaseUrl: account.baseUrl.trim() || null,
          apiModelCatalog: models.map((model) => model.alias || model.id).filter(Boolean),
        });
        await finishManagedImport('Claude API Key 账号已导入 API 代理账号池');
      } catch (error) {
        setModalStatus({ tone: 'error', text: `保存 Claude API Key 失败：${String(error).replace(/^Error:\s*/, '')}` });
      } finally {
        setLocalBusy(false);
      }
      return;
    }
    setLocalBusy(true);
    setModalStatus({ tone: 'loading', text: '正在按 Codex API Key 账号方式保存...' });
    try {
      const models = parseModels(modelText);
      const modelIds = models.map((model) => model.alias || model.id).filter(Boolean);
      await codexService.addCodexAccountWithApiKey(
        apiKey,
        account.baseUrl.trim() || undefined,
        undefined,
        undefined,
        undefined,
        modelIds.length ? modelIds : undefined,
        models.some((model) => model.capabilities.includes('vision')),
        Object.fromEntries(models.map((model) => [model.alias || model.id, model.capabilities.includes('vision')])),
        undefined,
        account.name.trim() || undefined,
      );
      await finishManagedImport('Codex API Key 账号已导入 API 代理账号池');
    } catch (error) {
      setModalStatus({ tone: 'error', text: `保存 Codex API Key 失败：${String(error).replace(/^Error:\s*/, '')}` });
    } finally {
      setLocalBusy(false);
    }
  };

  const handleTokenSubmit = async () => {
    const text = credentialText.trim();
    if (!text) {
      setModalStatus({ tone: 'error', text: '请粘贴 Token / JSON 内容' });
      return;
    }
    if (!isCodex) {
      if (isGemini) {
        setLocalBusy(true);
        setModalStatus({ tone: 'loading', text: '正在导入 Gemini Token / JSON...' });
        try {
          if (looksLikeJson(text)) await geminiService.importGeminiFromJson(text);
          else await geminiService.addGeminiAccountWithToken(text);
          await finishManagedImport('Gemini Token / JSON 账号已导入 API 代理账号池');
        } catch (error) {
          setModalStatus({ tone: 'error', text: `导入 Gemini Token / JSON 失败：${String(error).replace(/^Error:\s*/, '')}` });
        } finally {
          setLocalBusy(false);
        }
        return;
      }
      if (isClaude) {
        setLocalBusy(true);
        setModalStatus({ tone: 'loading', text: '正在导入 Claude Token / JSON...' });
        try {
          await claudeService.importClaudeFromJson(text);
          await finishManagedImport('Claude Token / JSON 账号已导入 API 代理账号池');
        } catch (error) {
          setModalStatus({ tone: 'error', text: `导入 Claude Token / JSON 失败：${String(error).replace(/^Error:\s*/, '')}` });
        } finally {
          setLocalBusy(false);
        }
        return;
      }
      if (isAntigravity) {
        setLocalBusy(true);
        setModalStatus({ tone: 'loading', text: '正在导入 Antigravity Token / JSON...' });
        try {
          if (looksLikeJson(text)) await accountService.importFromJson(text);
          else await accountService.addAccountWithToken(text);
          await finishManagedImport('Antigravity Token / JSON 账号已导入 API 代理账号池');
        } catch (error) {
          setModalStatus({ tone: 'error', text: `导入 Antigravity Token / JSON 失败：${String(error).replace(/^Error:\s*/, '')}` });
        } finally {
          setLocalBusy(false);
        }
        return;
      }
      if (isXai) {
        setLocalBusy(true);
        setModalStatus({ tone: 'loading', text: '正在解析 Grok / Sub2API 账号并用 refresh_token 换取可用凭据...' });
        try {
          await multiModelApiService.importXaiAccountsJson(text);
          await finishManagedImport('Grok / Sub2API 账号已导入 API 账号池并完成凭据检测');
        } catch (error) {
          setModalStatus({ tone: 'error', text: `导入 Grok 账号失败：${String(error).replace(/^Error:\s*/, '')}` });
        } finally {
          setLocalBusy(false);
        }
        return;
      }
      await onSubmit({ ...account, authMode: 'oauth_json', apiKey: '' }, text);
      return;
    }
    setLocalBusy(true);
    setModalStatus({ tone: 'loading', text: '正在按 Codex Token / JSON 账号方式导入...' });
    try {
      await codexService.importCodexFromJson(text);
      await finishManagedImport('Codex Token / JSON 账号已导入 API 代理账号池');
    } catch (error) {
      setModalStatus({ tone: 'error', text: `导入 Codex Token / JSON 失败：${String(error).replace(/^Error:\s*/, '')}` });
    } finally {
      setLocalBusy(false);
    }
  };

  const handleImportLocal = async () => {
    setLocalBusy(true);
    setModalStatus({ tone: 'loading', text: `正在导入本机 ${providerLabel(account.provider)} 登录态...` });
    try {
      if (isCodex) await codexService.importCodexFromLocal();
      else if (isGemini) await geminiService.importGeminiFromLocal();
      else if (isClaude) await claudeService.importClaudeCliFromLocal();
      else if (isAntigravity) await accountService.importFromLocal();
      else if (isXai) await multiModelApiService.importLocalXaiAccounts();
      else {
        setModalStatus({ tone: 'info', text: '当前供应商没有固定本机登录态路径；请选择 JSON 文件或使用 Token / JSON。' });
        return;
      }
      await finishManagedImport(`本机 ${providerLabel(account.provider)} 登录态已导入 API 代理账号池`);
    } catch (error) {
      setModalStatus({ tone: 'error', text: `本地导入失败：${String(error).replace(/^Error:\s*/, '')}` });
    } finally {
      setLocalBusy(false);
    }
  };

  const handleImportFiles = async () => {
    setLocalBusy(true);
    setModalStatus({ tone: 'loading', text: '请选择 JSON 文件...' });
    try {
      const selected = await openFileDialog({
        multiple: true,
        filters: isXai
          ? [{ name: 'Grok / Sub2API 账号', extensions: ['json', 'txt', 'csv'] }]
          : [{ name: 'JSON', extensions: ['json'] }],
      });
      const filePaths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (!filePaths.length) {
        setModalStatus(null);
        return;
      }
      if (isCodex) await codexService.importCodexFromFiles(filePaths);
      else if (isAntigravity) await accountService.importFromFiles(filePaths);
      else if (isXai) {
        for (const path of filePaths) await multiModelApiService.importXaiAccountsJson(await readTextFile(path));
      }
      else {
        const raw = await readTextFile(filePaths[0]);
        if (isGemini) await geminiService.importGeminiFromJson(raw);
        else if (isClaude) await claudeService.importClaudeFromJson(raw);
        else await onSubmit({ ...account, authMode: 'oauth_json', apiKey: '' }, raw);
      }
      if (isCodex || isGemini || isClaude || isAntigravity || isXai) {
        await finishManagedImport(`${providerLabel(account.provider)} JSON 文件账号已导入 API 代理账号池`);
      }
    } catch (error) {
      setModalStatus({ tone: 'error', text: `文件导入失败：${String(error).replace(/^Error:\s*/, '')}` });
    } finally {
      setLocalBusy(false);
    }
  };

  return <div className="mm-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="mm-modal mm-account-add-modal" role="dialog" aria-modal="true" aria-label={isNew ? '添加上游账号' : '编辑上游账号'}>
      <header><div><h2>{isNew ? '添加上游账号' : '编辑上游账号'}</h2><p>每个账号是一条独立凭证；OAuth、Token / JSON、API Key、导入都按当前供应商执行，不再只做展示。</p></div><button type="button" onClick={onClose} aria-label="关闭"><X /></button></header>
      <div className="mm-modal-provider-grid">
        {PROVIDERS.map((provider) => <button type="button" key={provider.id} className={account.provider === provider.id ? 'active' : ''} onClick={() => onProvider(provider.id)} disabled={disabled}><span className={`mm-provider-icon ${provider.id}`}><ProviderIcon provider={provider.id} /></span><b>{provider.short}</b></button>)}
      </div>
      <div className="mm-modal-auth-tabs" role="tablist" aria-label="账号添加方式">
        <button type="button" className={addMode === 'oauth' ? 'active' : ''} onClick={() => setAddMode('oauth')} disabled={disabled || isSeedance}><Globe size={14} /><span>OAuth 授权</span></button>
        <button type="button" className={addMode === 'token' ? 'active' : ''} onClick={() => setAddMode('token')} disabled={disabled || isSeedance}><FileText size={14} /><span>Token / JSON</span></button>
        <button type="button" className={addMode === 'api_key' ? 'active' : ''} onClick={() => setAddMode('api_key')} disabled={disabled}><KeyRound size={14} /><span>{isSeedance ? 'connect.sid' : 'API Key'}</span></button>
        <button type="button" className={addMode === 'import' ? 'active' : ''} onClick={() => setAddMode('import')} disabled={disabled || isSeedance}><Database size={14} /><span>导入</span></button>
      </div>
      <div className="mm-modal-form mm-modal-form-codex-like">
        <label><span>账号名称</span><input autoFocus value={account.name} onChange={(event) => setAccount({ ...account, name: event.target.value })} placeholder={`例如 ${providerLabel(account.provider)} 主账号`} /></label>
        <label><span>优先级</span><input type="number" value={account.priority} onChange={(event) => setAccount({ ...account, priority: Number(event.target.value) })} /></label>
        <label><span>模型前缀</span><input value={account.prefix} onChange={(event) => setAccount({ ...account, prefix: event.target.value })} placeholder="可选" /></label>
        <label><span>Base URL</span><input value={account.baseUrl} onChange={(event) => setAccount({ ...account, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>

        {addMode === 'oauth' && (
          <div className="mm-add-section wide">
            {hasNativeOAuth ? <>
              <div className="mm-oauth-draft-card">
                {isCodex ? <>
                  <label><span>待授权账号</span><input type="email" value={pendingEmail} onChange={(event) => setPendingEmail(event.target.value)} placeholder="输入 OpenAI 账号邮箱" disabled={disabled} /></label>
                  <button type="button" className="btn btn-secondary" onClick={() => void handleSavePendingNativeOAuth()} disabled={disabled || !pendingEmail.trim()}><FileText size={16} />保存待授权卡片</button>
                </> : isXai ? <>
                  <p className="section-desc">xAI 设备验证码是短时会话，不能保存成跨重启的待授权账号。未完成时请重新生成验证码，不会写入无效凭据。</p>
                  <button type="button" className="btn btn-secondary" onClick={() => void startNativeOauth(true)} disabled={disabled}><Globe size={16} />重新生成设备验证码</button>
                </> : isClaude ? <>
                  <label><span>Claude 邮箱备注（可选）</span><input type="email" value={claudeEmailHint} onChange={(event) => setClaudeEmailHint(event.target.value)} placeholder="用于保存账号名称" disabled={disabled} /></label>
                  <button type="button" className="btn btn-secondary" onClick={() => void startNativeOauth(true)} disabled={disabled}><Globe size={16} />重新生成链接</button>
                </> : <>
                  <p className="section-desc">使用 {providerLabel(account.provider)} 账号页同款 OAuth 流程，授权后自动同步到多模型 API 代理账号池。</p>
                  <button type="button" className="btn btn-secondary" onClick={() => void startNativeOauth(true)} disabled={disabled}><Globe size={16} />重新生成链接</button>
                </>}
              </div>
              <p className="section-desc">{providerLabel(account.provider)} 已接入真实 OAuth 流程。打开授权链接完成登录，随后自动或手动提交回调并同步到多模型 API 代理账号池。</p>
              {oauthUrl ? <div className="mm-oauth-url-section">
                <label><span>授权链接</span><div className="mm-oauth-url-box"><input value={oauthUrl} readOnly /><button type="button" onClick={() => void handleCopyOauthUrl()}>{oauthUrlCopied ? <Check size={16} /> : <Copy size={16} />}</button></div></label>
                {isXai && xaiUserCode && <div className="mm-xai-device-code"><span>设备验证码</span><strong>{xaiUserCode}</strong><button type="button" onClick={() => void copyText(xaiUserCode)}><Copy size={15} />复制</button></div>}
                <button type="button" className="btn btn-primary btn-full" onClick={() => void handleOpenOauthUrl()} disabled={disabled}><Globe size={16} />在浏览器中打开</button>
                {!isXai && <label><span>手动输入回调地址 / code</span><div className="mm-oauth-url-box mm-oauth-callback-box"><input value={oauthCallbackInput} onChange={(event) => setOauthCallbackInput(event.target.value)} placeholder="粘贴完整回调地址或授权页面返回的 code" /><button type="button" onClick={() => void handleSubmitOauthCallback()} disabled={disabled || (!oauthCallbackInput.trim() && oauthProviderRef.current !== 'antigravity')}><Check size={16} /><span>我已授权，继续</span></button></div></label>}
                {isXai && <button type="button" className="btn btn-primary btn-full" onClick={() => void handleSubmitOauthCallback()} disabled={disabled || !oauthLoginIdRef.current}><Check size={16} />我已授权，继续并检测额度</button>}
                <p className="oauth-hint">{isXai ? '使用 xAI 官方 OIDC Device Flow，不需要粘贴回调地址；完成授权后程序会轮询 token、保存 refresh token 并检测套餐额度。' : 'Codex/Gemini 支持回调自动更新；Claude 通常需要粘贴 code 或完整回调地址；Antigravity 可直接点继续或粘贴回调地址。'}</p>
              </div> : <div className="mm-oauth-loading"><RefreshCw className="spin" />正在准备授权链接...</div>}
            </> : <>
              <p className="section-desc">当前供应商使用通用 OAuth2 Authorization Code + PKCE。填写供应商提供的 Authorization URL、Token URL、Client ID 等参数后生成授权链接，回调交换出来的 credential 会直接写入当前上游账号。</p>
              <div className="mm-generic-oauth-grid">
                <label><span>Authorization URL</span><input value={genericDraft.authorizationUrl} onChange={(event) => setGenericDraft({ ...genericDraft, authorizationUrl: event.target.value })} placeholder="https://provider.example.com/oauth/authorize" /></label>
                <label><span>Token URL</span><input value={genericDraft.tokenUrl} onChange={(event) => setGenericDraft({ ...genericDraft, tokenUrl: event.target.value })} placeholder="https://provider.example.com/oauth/token" /></label>
                <label><span>Client ID</span><input value={genericDraft.clientId} onChange={(event) => setGenericDraft({ ...genericDraft, clientId: event.target.value })} placeholder="OAuth client_id" /></label>
                <label><span>Client Secret（可选）</span><input type={secretVisible ? 'text' : 'password'} value={genericDraft.clientSecret} onChange={(event) => setGenericDraft({ ...genericDraft, clientSecret: event.target.value })} placeholder="public client 可留空" /></label>
                <label><span>Scope</span><input value={genericDraft.scope} onChange={(event) => setGenericDraft({ ...genericDraft, scope: event.target.value })} placeholder="openid profile email offline_access" /></label>
                <label><span>Redirect URI</span><input value={genericDraft.redirectUri} onChange={(event) => setGenericDraft({ ...genericDraft, redirectUri: event.target.value })} placeholder="http://127.0.0.1:1455/auth/callback" /></label>
                <label><span>Authorize 额外参数（每行 key=value）</span><textarea rows={3} value={genericDraft.extraAuthorizeParams} onChange={(event) => setGenericDraft({ ...genericDraft, extraAuthorizeParams: event.target.value })} placeholder={'audience=...\nprompt=consent'} /></label>
                <label><span>Token 额外参数（每行 key=value）</span><textarea rows={3} value={genericDraft.extraTokenParams} onChange={(event) => setGenericDraft({ ...genericDraft, extraTokenParams: event.target.value })} placeholder="resource=..." /></label>
              </div>
              <button type="button" className="btn btn-primary btn-full" onClick={() => void handleGenericOAuthStart()} disabled={disabled || !genericDraft.authorizationUrl.trim() || !genericDraft.clientId.trim() || !genericDraft.redirectUri.trim()}><Globe size={16} />生成 OAuth 授权链接</button>
              {oauthUrl && <div className="mm-oauth-url-section">
                <label><span>授权链接</span><div className="mm-oauth-url-box"><input value={oauthUrl} readOnly /><button type="button" onClick={() => void handleCopyOauthUrl()}>{oauthUrlCopied ? <Check size={16} /> : <Copy size={16} />}</button></div></label>
                <button type="button" className="btn btn-primary btn-full" onClick={() => void handleOpenOauthUrl()} disabled={disabled}><Globe size={16} />在浏览器中打开</button>
                <label><span>回调地址 / code</span><div className="mm-oauth-url-box mm-oauth-callback-box"><input value={oauthCallbackInput} onChange={(event) => setOauthCallbackInput(event.target.value)} placeholder="https://.../callback?code=...&state=... 或直接粘贴 code" /><button type="button" onClick={() => void handleGenericOAuthExchange()} disabled={disabled || !oauthCallbackInput.trim() || !genericDraft.tokenUrl.trim()}><Check size={16} /><span>交换并保存</span></button></div></label>
              </div>}
            </>}
          </div>
        )}

        {addMode === 'api_key' && (
          <div className="mm-add-section wide">
            <label><span>{isSeedance ? 'connect.sid / Cookie' : 'API Key'}</span><div className="mm-secret-field"><input type={secretVisible ? 'text' : 'password'} value={account.apiKey} onChange={(event) => setAccount({ ...account, apiKey: event.target.value })} placeholder={isSeedance ? '粘贴 connect.sid 值或完整 Cookie Header' : '粘贴供应商 API Key'} autoComplete="off" spellCheck={false} /><button type="button" onClick={() => setSecretVisible((visible) => !visible)}>{secretVisible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
            <p className="section-desc">{isSeedance ? '凭证直接进入现有 1466 多模型账号池；文生视频与图生视频统一使用 /v1/videos/generations，不会启动第二个 API 网关。' : isCodex || isClaude ? '将调用对应账号页同款 API Key 保存逻辑，再同步到 API 代理账号池。' : '保存为当前供应商的上游 API Key 凭证。'}</p>
            <button type="button" className="btn btn-primary btn-full" onClick={() => void handleApiKeySubmit()} disabled={disabled || !account.apiKey.trim()}><KeyRound size={16} />添加账号</button>
          </div>
        )}

        {addMode === 'token' && (
          <div className="mm-add-section wide">
            <p className="section-desc">{isXai ? '支持官方 Grok CLI auth.json、Sub2API 导出 JSON、OAuth Token JSON，也支持账号商常用的“账号 + 密码 + RT”逐行批量格式。只有 refresh_token 也可以，导入后会自动交换 access_token 并检测额度。' : 'Token / JSON 会按供应商分别导入：Codex、Gemini、Claude、Antigravity 走各自账号模块；OpenAI、自定义则直接作为 OAuth credential 写入多模型代理。'}</p>
            <label><span>{isXai ? 'Grok / Sub2API 账号、Token 或 JSON' : `${providerLabel(account.provider)} Token / JSON`}</span><textarea value={credentialText} onChange={(event) => setCredentialText(event.target.value)} rows={8} placeholder={isXai ? '每行一个：email@example.com----账号密码----rt_xxx\n也支持 |、Tab、:: 分隔，或直接粘贴 Sub2API / Grok CLI JSON' : isCodex ? '{"tokens":{"access_token":"...","refresh_token":"..."}}' : `{"type":"${account.provider}","access_token":"...","refresh_token":"..."}`} /></label>
            <button type="button" className="btn btn-primary btn-full" onClick={() => void handleTokenSubmit()} disabled={disabled || !credentialText.trim()}><Download size={16} />导入</button>
          </div>
        )}

        {addMode === 'import' && (
          <div className="mm-add-section wide">
            <p className="section-desc">{isXai ? '可导入本机 Grok CLI 登录态，或选择 JSON/TXT/CSV 文件。文件支持 Sub2API JSON 和每行“账号----密码----refresh_token”的账号池格式。' : '优先从本机已登录账号导入；也可以选择 JSON 文件。没有固定本机登录态的供应商会把 JSON 文件直接作为当前上游 credential 保存。'}</p>
            <button type="button" className="btn btn-primary btn-full" onClick={() => void handleImportLocal()} disabled={disabled}>{localBusy ? <RefreshCw size={16} className="spin" /> : <Database size={16} />}获取本机 {providerLabel(account.provider)} 账号</button>
            <button type="button" className="btn btn-secondary btn-full" onClick={() => void handleImportFiles()} disabled={disabled}><FileUp size={16} />{isXai ? '从 Sub2API / JSON / TXT 文件导入' : '从 JSON 文件导入'}</button>
          </div>
        )}

        <label className="wide"><span>模型（每行：model_id | alias | text,vision,image,video）</span><textarea value={modelText} onChange={(event) => setModelText(event.target.value)} rows={6} /></label>
        <label className="wide"><span>账号代理</span><input value={account.proxyUrl} onChange={(event) => setAccount({ ...account, proxyUrl: event.target.value })} placeholder="http://127.0.0.1:7890（可选）" /></label>
        {modalStatus && <div className={`mm-add-status ${modalStatus.tone} wide`}>{modalStatus.tone === 'success' ? <Check size={16} /> : modalStatus.tone === 'loading' ? <RefreshCw size={16} className="spin" /> : <CircleAlert size={16} />}<span>{modalStatus.text}</span></div>}
      </div>
      <footer><button type="button" className="btn btn-secondary" onClick={onClose} disabled={disabled}>取消</button>{(addMode === 'api_key' || addMode === 'token') && <button type="button" className="btn btn-primary" onClick={() => void (addMode === 'api_key' ? handleApiKeySubmit() : handleTokenSubmit())} disabled={disabled}><Save />保存账号</button>}</footer>
    </div>
  </div>;
}

function Routes({ baseUrl, apiKey, copied, copy }: { baseUrl: string; apiKey: string; copied: string; copy: (value: string, id: string) => Promise<void> }) {
  const routes = [
    { id: 'models', icon: <Boxes />, title: '模型列表', method: 'GET', path: '/v1/models', code: `curl ${baseUrl}/v1/models -H "Authorization: Bearer ${apiKey}"` },
    { id: 'chat', icon: <Sparkles />, title: 'Chat Completions', method: 'POST', path: '/v1/chat/completions', code: `curl ${baseUrl}/v1/chat/completions -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"model":"grok-4.3","messages":[{"role":"user","content":"Hello"}]}'` },
    { id: 'image', icon: <Image />, title: '图片生成 / 编辑', method: 'POST', path: '/v1/images/generations', code: `curl ${baseUrl}/v1/images/generations -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"model":"grok-imagine-image","prompt":"a glass city at dawn"}'` },
    { id: 'video', icon: <Film />, title: '视频生成（Veo / Grok / Seedance）', method: 'POST', path: '/v1/videos/generations', code: `curl ${baseUrl}/v1/videos/generations -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"model":"doubao-seedance-1.5-pro","prompt":"cinematic ocean storm","seconds":5,"size":"1280x720"}'` },
    { id: 'video-status', icon: <RefreshCw />, title: 'Seedance 任务状态', method: 'GET', path: '/v1/videos/generations/{video_id}', code: `curl ${baseUrl}/v1/videos/generations/VIDEO_ID -H "Authorization: Bearer ${apiKey}"` },
  ];
  return <section className="mm-api-panel"><header className="mm-api-panel-head"><div><h2>统一网关路线</h2><p>OpenAI-compatible 文本、图片与视频端点；同一个 Bearer Key 通行全部授权模型。</p></div></header><div className="mm-route-grid">{routes.map((route) => <article className="mm-route" key={route.id}><header><span>{route.icon}</span><div><h3>{route.title}</h3><code><b>{route.method}</b> {route.path}</code></div></header><pre>{route.code}</pre><button type="button" onClick={() => void copy(route.code, route.id)}>{copied === route.id ? <Check /> : <Copy />}{copied === route.id ? '已复制' : '复制 cURL'}</button></article>)}</div></section>;
}
