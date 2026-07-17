import { useEffect, useMemo, useState } from 'react';
import {
  desktopApi,
  type MultiProxyImageApiMode,
  type MultiProxyImageTestResult,
  type MultiProxySnapshot,
  type MultiProxyStatus,
  type MultiProxyTestResult,
} from '@/lib/desktopApi';

type Config = MultiProxySnapshot['config'];
type AnyItem = Record<string, unknown>;
type ModelCapability = 'chat' | 'image';

type ProviderDraft = {
  id: string;
  label: string;
  kind: string;
  enabled: boolean;
  baseUrl: string;
  defaultProxyId: string;
  timeoutMs: string;
};

type AccountDraft = {
  id: string;
  providerId: string;
  label: string;
  enabled: boolean;
  priority: string;
  apiKey: string;
  apiKeyEnv: string;
};

type ModelDraft = {
  id: string;
  providerId: string;
  upstreamModel: string;
  strategy: string;
  capability: ModelCapability;
  candidatesText: string;
};

type IconName = 'gateway' | 'provider' | 'account' | 'route' | 'config' | 'status' | 'copy' | 'send' | 'refresh' | 'save' | 'trash' | 'globe' | 'file' | 'key' | 'database' | 'image';
type ImportMode = 'oauth' | 'token-json' | 'api-key' | 'import';

function Icon({ name }: { name: IconName }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'gateway':
      return <svg {...common}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" /><path d="M12 8v8" /><path d="M8.5 10.5l7 3" /><path d="M15.5 10.5l-7 3" /></svg>;
    case 'provider':
      return <svg {...common}><path d="M4 7h16" /><path d="M7 7v10" /><path d="M17 7v10" /><path d="M4 17h16" /><path d="M9.5 12h5" /></svg>;
    case 'account':
      return <svg {...common}><circle cx="12" cy="8" r="3" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>;
    case 'route':
      return <svg {...common}><path d="M5 5h4a4 4 0 0 1 4 4v6a4 4 0 0 0 4 4h2" /><path d="M15 5h4" /><path d="M17 3l2 2-2 2" /><path d="M17 17l2 2-2 2" /></svg>;
    case 'config':
      return <svg {...common}><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" /><path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.05.05a2.1 2.1 0 1 1-2.97 2.97l-.05-.05a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.1 1.66V21a2.1 2.1 0 1 1-4.2 0v-.08a1.8 1.8 0 0 0-1.1-1.66 1.8 1.8 0 0 0-1.98.36l-.05.05a2.1 2.1 0 1 1-2.97-2.97l.05-.05A1.8 1.8 0 0 0 3.6 15a1.8 1.8 0 0 0-1.66-1.1H2a2.1 2.1 0 1 1 0-4.2h.08A1.8 1.8 0 0 0 3.74 8a1.8 1.8 0 0 0-.36-1.98l-.05-.05A2.1 2.1 0 1 1 6.3 3l.05.05A1.8 1.8 0 0 0 8.33 3.4 1.8 1.8 0 0 0 9.43 1.8V2a2.1 2.1 0 1 1 4.2 0v-.08a1.8 1.8 0 0 0 1.1 1.66 1.8 1.8 0 0 0 1.98-.36l.05-.05a2.1 2.1 0 1 1 2.97 2.97l-.05.05A1.8 1.8 0 0 0 19.4 8a1.8 1.8 0 0 0 1.66 1.1H21a2.1 2.1 0 1 1 0 4.2h-.08A1.8 1.8 0 0 0 19.4 15z" /></svg>;
    case 'status':
      return <svg {...common}><path d="M4 14h4l2-8 4 12 2-4h4" /></svg>;
    case 'copy':
      return <svg {...common}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" /></svg>;
    case 'send':
      return <svg {...common}><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" /></svg>;
    case 'refresh':
      return <svg {...common}><path d="M20 12a8 8 0 0 1-13.7 5.7" /><path d="M4 12A8 8 0 0 1 17.7 6.3" /><path d="M17 2v5h5" /><path d="M7 22v-5H2" /></svg>;
    case 'save':
      return <svg {...common}><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></svg>;
    case 'trash':
      return <svg {...common}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 15H6L5 6" /></svg>;
    case 'globe':
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18" /><path d="M12 3a14 14 0 0 0 0 18" /></svg>;
    case 'file':
      return <svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8" /><path d="M8 17h6" /></svg>;
    case 'key':
      return <svg {...common}><circle cx="7.5" cy="14.5" r="3.5" /><path d="M10 12l9-9" /><path d="M15 7l2 2" /><path d="M17 5l2 2" /></svg>;
    case 'database':
      return <svg {...common}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></svg>;
    case 'image':
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5L5 20" /></svg>;
  }
}

function TitleWithIcon({ icon, title, subtitle }: { icon: IconName; title: string; subtitle?: string }) {
  return <div className="title-with-icon"><span className="icon-tile"><Icon name={icon} /></span><div><h2>{title}</h2>{subtitle ? <p className="subtle">{subtitle}</p> : null}</div></div>;
}

const importTabs: Array<{ id: ImportMode; label: string; icon: IconName }> = [
  { id: 'oauth', label: 'OAuth 授权', icon: 'globe' },
  { id: 'token-json', label: 'Token / JSON', icon: 'file' },
  { id: 'api-key', label: 'API Key', icon: 'key' },
  { id: 'import', label: '导入', icon: 'database' },
];

const emptyProvider: ProviderDraft = {
  id: '',
  label: '',
  kind: 'openai_compatible',
  enabled: true,
  baseUrl: '',
  defaultProxyId: 'direct',
  timeoutMs: '120000',
};

const emptyAccount: AccountDraft = {
  id: '',
  providerId: '',
  label: '',
  enabled: true,
  priority: '10',
  apiKey: '',
  apiKeyEnv: '',
};

const emptyModel: ModelDraft = {
  id: '',
  providerId: '',
  upstreamModel: '',
  strategy: 'round_robin',
  capability: 'chat',
  candidatesText: '',
};

function text(value: unknown, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function badgeClass(value: unknown) {
  return `badge ${text(value, 'disabled')}`;
}

function numberOr(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function candidateLinesToItems(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [providerId, model, accountIds] = line.split(':').map((part) => part.trim());
      return {
        providerId,
        model,
        ...(accountIds ? { accountIds: accountIds.split(',').map((item) => item.trim()).filter(Boolean) } : {}),
      };
    })
    .filter((item) => item.providerId && item.model);
}

function candidatesToLines(candidates: unknown) {
  if (!Array.isArray(candidates)) return '';
  return candidates
    .map((candidate) => {
      const item = candidate as AnyItem;
      const accountIds = Array.isArray(item.accountIds) ? `:${item.accountIds.join(',')}` : '';
      return `${text(item.providerId, '')}:${text(item.model, '')}${accountIds}`;
    })
    .join('\n');
}

function normalizeConfig(config: Config): Config {
  return JSON.parse(JSON.stringify(config)) as Config;
}

function isObject(value: unknown): value is AnyItem {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergeById(existing: AnyItem[], incoming: AnyItem[]) {
  const next = [...existing];
  for (const item of incoming) {
    if (!isObject(item)) continue;
    const id = item.id;
    const index = next.findIndex((current) => current.id === id && id !== undefined && id !== '');
    if (index >= 0) next[index] = item;
    else next.push(item);
  }
  return next;
}

function looksLikeImageModel(value: unknown) {
  const next = text(value, '').trim().toLowerCase();
  return next.startsWith('gpt-image-') || next.includes('-image') || next.startsWith('dall-e');
}

function capabilitiesOf(model: AnyItem) {
  const explicit = Array.isArray(model.capabilities)
    ? model.capabilities.map((item) => text(item, '').toLowerCase()).filter((item): item is ModelCapability => item === 'chat' || item === 'image')
    : [];
  if (explicit.length) return explicit;
  return looksLikeImageModel(model.upstreamModel ?? model.id) ? ['image'] : ['chat'];
}

function supportsCapability(model: AnyItem, capability: ModelCapability) {
  return capabilitiesOf(model).includes(capability);
}

function capabilityBadges(model: AnyItem) {
  const values = capabilitiesOf(model);
  return values.length ? (
    <div className="capability-row">
      {values.map((capability) => <span key={capability} className={`badge ${capability}`}>{capability}</span>)}
    </div>
  ) : <span className="badge disabled">unknown</span>;
}

function gatewaySummary(gateway: Record<string, unknown> | null | undefined) {
  if (!gateway) return '—';
  return [text(gateway.providerId, ''), text(gateway.accountId, ''), text(gateway.upstreamModel, '')].filter(Boolean).join(' / ');
}

export function MultiPlatformProxyPage() {
  const [status, setStatus] = useState<MultiProxyStatus | null>(null);
  const [snapshot, setSnapshot] = useState<MultiProxySnapshot | null>(null);
  const [adminToken, setAdminToken] = useState('local-admin-token');
  const [configText, setConfigText] = useState('');
  const [importMode, setImportMode] = useState<ImportMode>('token-json');
  const [bulkImportText, setBulkImportText] = useState('');
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(emptyProvider);
  const [accountDraft, setAccountDraft] = useState<AccountDraft>(emptyAccount);
  const [modelDraft, setModelDraft] = useState<ModelDraft>(emptyModel);
  const [imageApiMode, setImageApiMode] = useState<MultiProxyImageApiMode>('images');
  const [imageModel, setImageModel] = useState('');
  const [imagePrompt, setImagePrompt] = useState('一只蓝眼睛小猫，柔和工作室光照，插画风格');
  const [imageSize, setImageSize] = useState('1024x1024');
  const [imageQuality, setImageQuality] = useState('');
  const [imageBackground, setImageBackground] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastChatResult, setLastChatResult] = useState<MultiProxyTestResult | null>(null);
  const [lastImageResult, setLastImageResult] = useState<MultiProxyImageTestResult | null>(null);

  async function refresh(options?: { silent?: boolean }) {
    if (!options?.silent) setLoading(true);
    setError(null);
    try {
      const nextStatus = await desktopApi.getMultiProxyStatus();
      setStatus(nextStatus);
      if (nextStatus.health || nextStatus.running) {
        try {
          const nextSnapshot = await desktopApi.getMultiProxySnapshot(adminToken);
          setSnapshot(nextSnapshot);
          setConfigText(JSON.stringify(nextSnapshot.config, null, 2));
        } catch (reason) {
          if (nextStatus.running) throw reason;
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh({ silent: true }), 3000);
    return () => window.clearInterval(timer);
  }, [adminToken]);

  const providerIds = useMemo(() => snapshot?.config.providers.map((item) => text(item.id, '')) ?? [], [snapshot?.config.providers]);
  const modelNames = useMemo(() => snapshot?.config.models.map((model) => text(model.id)).join('、') || '暂无', [snapshot?.config.models]);
  const chatModelOptions = useMemo(() => snapshot?.config.models.filter((model) => supportsCapability(model, 'chat')).map((model) => text(model.id, '')) ?? [], [snapshot?.config.models]);
  const imageModelOptions = useMemo(() => snapshot?.config.models.filter((model) => supportsCapability(model, 'image')).map((model) => text(model.id, '')) ?? [], [snapshot?.config.models]);
  const defaultChatModel = useMemo(() => {
    const configured = snapshot?.config.defaultModel ?? 'coding-auto';
    return chatModelOptions.includes(configured) ? configured : (chatModelOptions[0] || configured);
  }, [chatModelOptions, snapshot?.config.defaultModel]);

  useEffect(() => {
    if (!imageModelOptions.length) {
      setImageModel('');
      return;
    }
    if (!imageModel || !imageModelOptions.includes(imageModel)) {
      setImageModel(imageModelOptions[0]);
    }
  }, [imageModel, imageModelOptions]);

  function patchConfig(updater: (config: Config) => Config) {
    if (!snapshot) return;
    const nextConfig = normalizeConfig(updater(normalizeConfig(snapshot.config)));
    const nextSnapshot = { ...snapshot, config: nextConfig };
    setSnapshot(nextSnapshot);
    setConfigText(JSON.stringify(nextConfig, null, 2));
  }

  async function wrapBusy(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      await action();
      await refresh({ silent: true });
      setMessage(successMessage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function testChat() {
    await wrapBusy(async () => {
      if (!defaultChatModel) throw new Error('当前没有可用的 chat-capable 模型。');
      const result = await desktopApi.testMultiProxyChat('你好，验证多平台反代', defaultChatModel);
      if (!result.ok) throw new Error(`测试失败 HTTP ${result.status}: ${result.rawBody}`);
      setLastChatResult(result);
      setMessage(`反代测试成功：${result.responseText || result.rawBody}`);
    }, '测试发送完成。');
  }

  async function testImageGeneration() {
    await wrapBusy(async () => {
      const model = imageModel || imageModelOptions[0];
      if (!model) throw new Error('当前没有可用的 image-capable 模型。');
      const result = await desktopApi.testMultiProxyImage({
        apiMode: imageApiMode,
        model,
        prompt: imagePrompt,
        size: imageSize || undefined,
        quality: imageQuality || undefined,
        background: imageBackground || undefined,
      });
      if (!result.ok) throw new Error(`图片生成失败 HTTP ${result.status}: ${result.debugBodyPreview}`);
      setLastImageResult(result);
      setMessage(`图片生成成功：${result.images.length || 0} 张，模式 ${result.apiMode}`);
    }, '图片生成完成。');
  }

  async function copyApiUrl() {
    if (!status) return;
    await navigator.clipboard?.writeText(status.apiBaseUrl);
    setMessage(`已复制 ${status.apiBaseUrl}`);
  }

  async function saveConfig() {
    await wrapBusy(async () => {
      const parsed = JSON.parse(configText) as Config;
      const next = await desktopApi.saveMultiProxyConfig(parsed, adminToken);
      setSnapshot(next);
      setConfigText(JSON.stringify(next.config, null, 2));
    }, '多平台 API 配置已保存。');
  }

  async function reloadConfig() {
    await wrapBusy(async () => {
      const next = await desktopApi.reloadMultiProxy(adminToken);
      setSnapshot(next);
      setConfigText(JSON.stringify(next.config, null, 2));
    }, '多平台 API 配置已重新加载。');
  }

  async function resetRuntime() {
    await wrapBusy(async () => {
      const next = await desktopApi.resetMultiProxyRuntime(adminToken);
      setSnapshot(next);
    }, '运行态已重置。');
  }

  function addProvider() {
    const id = providerDraft.id.trim() || uid('provider');
    patchConfig((config) => ({
      ...config,
      providers: [
        ...config.providers.filter((item) => item.id !== id),
        {
          id,
          label: providerDraft.label.trim() || id,
          kind: providerDraft.kind || 'openai_compatible',
          enabled: providerDraft.enabled,
          baseUrl: providerDraft.baseUrl.trim(),
          defaultProxyId: providerDraft.defaultProxyId.trim() || 'direct',
          timeoutMs: numberOr(providerDraft.timeoutMs, 120000),
        },
      ],
    }));
    setProviderDraft(emptyProvider);
  }

  function addAccount() {
    const providerId = accountDraft.providerId.trim() || providerIds[0] || '';
    const id = accountDraft.id.trim() || uid(`${providerId || 'account'}`);
    patchConfig((config) => ({
      ...config,
      accounts: [
        ...config.accounts.filter((item) => item.id !== id),
        {
          id,
          providerId,
          label: accountDraft.label.trim() || id,
          enabled: accountDraft.enabled,
          priority: numberOr(accountDraft.priority, 10),
          auth: {
            type: 'api_key',
            ...(accountDraft.apiKey.trim() ? { apiKey: accountDraft.apiKey.trim() } : {}),
            ...(accountDraft.apiKeyEnv.trim() ? { apiKeyEnv: accountDraft.apiKeyEnv.trim() } : {}),
          },
        },
      ],
    }));
    setAccountDraft(emptyAccount);
  }

  function addModel() {
    const id = modelDraft.id.trim() || uid('model');
    const isFallback = modelDraft.strategy === 'fallback';
    const capabilities = [modelDraft.capability];
    patchConfig((config) => ({
      ...config,
      models: [
        ...config.models.filter((item) => item.id !== id),
        isFallback
          ? { id, strategy: 'fallback', capabilities, candidates: candidateLinesToItems(modelDraft.candidatesText) }
          : {
              id,
              providerId: modelDraft.providerId.trim(),
              upstreamModel: modelDraft.upstreamModel.trim() || id,
              strategy: modelDraft.strategy || 'round_robin',
              capabilities,
            },
      ],
    }));
    setModelDraft(emptyModel);
  }

  function removeConfigItem(key: 'providers' | 'accounts' | 'models', id: unknown) {
    patchConfig((config) => ({ ...config, [key]: config[key].filter((item) => item.id !== id) }));
  }

  function applyTokenJsonImport() {
    try {
      const parsed = JSON.parse(bulkImportText) as Partial<Config> | AnyItem | AnyItem[];
      patchConfig((config) => {
        if (Array.isArray(parsed)) return { ...config, accounts: mergeById(config.accounts, parsed) };
        if (!isObject(parsed)) return config;
        if ('providers' in parsed || 'accounts' in parsed || 'models' in parsed || 'proxies' in parsed) {
          const next = parsed as Partial<Config>;
          return {
            ...config,
            providers: mergeById(config.providers, next.providers ?? []),
            accounts: mergeById(config.accounts, next.accounts ?? []),
            models: mergeById(config.models, next.models ?? []),
            proxies: mergeById(config.proxies, next.proxies ?? []),
          };
        }
        return { ...config, accounts: mergeById(config.accounts, [parsed]) };
      });
      setBulkImportText('');
      setMessage('Token / JSON 已应用到当前配置，检查后点击“保存配置”。');
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? `Token / JSON 解析失败：${reason.message}` : String(reason));
    }
  }

  if (loading && !status) {
    return <main className="page-shell"><p>正在加载多平台 API 代理状态…</p></main>;
  }

  return (
    <main className="page-shell">
      <section className="panel status-panel">
        <div className="hero-title">
          <span className="hero-icon"><Icon name="gateway" /></span>
          <div>
            <p className="eyebrow">API 代理服务</p>
            <h1>Multi Platform CLI Proxy API</h1>
            <p className="subtle">独立本地 OpenAI-compatible 反代服务，支持多平台、多账号、模型路由和失败 fallback。</p>
          </div>
        </div>

        <div className="status-grid">
          <div className="status-pill"><span>服务状态</span><strong className={status?.running ? 'ok' : 'muted'}>{status?.running ? '运行中' : '未启动'}</strong></div>
          <div className="status-pill wide"><span>API Base URL</span><code>{status?.apiBaseUrl ?? 'http://127.0.0.1:13978/v1'}</code></div>
          <div className="status-pill wide"><span>UI URL</span><code>{status?.uiUrl ?? 'http://127.0.0.1:13978/'}</code></div>
          <div className="status-pill"><span>进程 PID</span><strong>{status?.pid ?? '—'}</strong></div>
          <div className="status-pill"><span>默认聊天模型</span><strong>{defaultChatModel || '暂无'}</strong></div>
          <div className="status-pill"><span>图片模型数</span><strong>{imageModelOptions.length}</strong></div>
          <div className="status-pill"><span>Admin Token</span><input type="password" autoComplete="off" spellCheck={false} value={adminToken} onChange={(event) => setAdminToken(event.target.value)} /></div>
        </div>

        {status?.lastError ? <p className="error-text">最近错误：{status.lastError}</p> : null}

        <div className="gateway-toolbar">
          <div className="toggle-block">
            <span className="toggle-label">服务总开关</span>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={Boolean(status?.running)}
                disabled={busy}
                onChange={(event) =>
                  wrapBusy(
                    () => (event.target.checked ? desktopApi.startMultiProxy() : desktopApi.stopMultiProxy()),
                    event.target.checked ? '多平台 API 服务已启动。' : '多平台 API 服务已停止。',
                  )
                }
              />
              <span className="toggle-slider" />
            </label>
            <strong className={status?.running ? 'ok' : 'muted'}>{status?.running ? '运行中' : '已停止'}</strong>
          </div>
          <div className="button-row">
            <button className="secondary icon-button" disabled={busy} onClick={() => void copyApiUrl()}><Icon name="copy" />复制 API URL</button>
            <button className="primary icon-button" disabled={busy || !status?.running} onClick={() => void testChat()}><Icon name="send" />测试聊天反代</button>
            <button className="ghost icon-button" disabled={busy} onClick={() => void refresh()}><Icon name="refresh" />刷新状态</button>
          </div>
        </div>
      </section>

      {message ? <div className="callout success">{message}</div> : null}
      {error ? <div className="callout error">{error}</div> : null}

      {lastChatResult ? (
        <section className="panel">
          <div className="panel-header split"><TitleWithIcon icon="send" title="最近聊天测试" subtitle="保留最近一次聊天测试结果与网关信息。" /></div>
          <div className="status-grid compact image-status-grid">
            <div className="status-pill"><span>HTTP</span><strong>{lastChatResult.status}</strong></div>
            <div className="status-pill wide"><span>Gateway</span><code>{gatewaySummary(lastChatResult.gateway)}</code></div>
            <div className="status-pill wide"><span>响应摘要</span><code>{lastChatResult.responseText || lastChatResult.rawBody}</code></div>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-header split"><TitleWithIcon icon="image" title="图片生成测试" subtitle="使用 /v1/images/generations 或 /v1/responses 测试 image-capable 模型，并直接预览结果。" /></div>
        <div className="form-grid compact-form">
          <label><span>API 模式</span><select value={imageApiMode} onChange={(event) => setImageApiMode(event.target.value as MultiProxyImageApiMode)}><option value="images">images</option><option value="responses">responses</option></select></label>
          <label><span>图片模型</span><select value={imageModel} onChange={(event) => setImageModel(event.target.value)}><option value="">选择 image model</option>{imageModelOptions.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
          <label><span>尺寸</span><select value={imageSize} onChange={(event) => setImageSize(event.target.value)}><option value="1024x1024">1024x1024</option><option value="1536x1024">1536x1024</option><option value="1024x1536">1024x1536</option><option value="auto">auto</option></select></label>
          <label><span>Quality</span><select value={imageQuality} onChange={(event) => setImageQuality(event.target.value)}><option value="">默认</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
          <label><span>Background</span><select value={imageBackground} onChange={(event) => setImageBackground(event.target.value)}><option value="">默认</option><option value="transparent">transparent</option><option value="opaque">opaque</option></select></label>
          <div className="button-row form-actions"><button className="primary icon-button" disabled={busy || !status?.running || !imageModelOptions.length} onClick={() => void testImageGeneration()}><Icon name="image" />生成图片</button></div>
          <label className="full-width"><span>Prompt</span><textarea rows={4} value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} placeholder="输入图片生成提示词，例如：一只蓝眼睛小猫，柔和工作室光照，插画风格" /></label>
        </div>
        {lastImageResult ? (
          <div className="image-result-shell">
            <div className="status-grid compact image-status-grid">
              <div className="status-pill"><span>模式</span><strong>{lastImageResult.apiMode}</strong></div>
              <div className="status-pill"><span>HTTP</span><strong>{lastImageResult.status}</strong></div>
              <div className="status-pill"><span>图片数</span><strong>{lastImageResult.images.length}</strong></div>
              <div className="status-pill wide"><span>Gateway</span><code>{gatewaySummary(lastImageResult.gateway)}</code></div>
            </div>
            <div className="preview-grid">
              {lastImageResult.images.length ? lastImageResult.images.map((image, index) => (
                <article className="image-preview-card" key={image.dataUrl || image.url || `${index}`}>
                  <div className="image-preview-frame">
                    {image.dataUrl || image.url ? <img src={image.dataUrl || image.url || undefined} alt={`generated-${index + 1}`} /> : <div className="empty-preview">无预览数据</div>}
                  </div>
                  <div className="image-preview-meta">
                    <strong>图片 {index + 1}</strong>
                    {image.revisedPrompt ? <p>{image.revisedPrompt}</p> : null}
                    <code>{image.url || image.dataUrl ? 'preview-ready' : 'metadata-only'}</code>
                  </div>
                </article>
              )) : <div className="callout error">本次返回没有可预览的图片数据。</div>}
            </div>
            <div className="debug-shell">
              <span>调试摘要</span>
              <pre className="debug-preview">{lastImageResult.debugBodyPreview}</pre>
            </div>
          </div>
        ) : <p className="subtle">选择 image-capable 模型并生成后，会在这里显示图片预览与网关信息。</p>}
      </section>

      <section className="panel stats-panel">
        <TitleWithIcon icon="status" title="当前网关摘要" subtitle="运行态和配置规模概览。" />
        <div className="stats-grid">
          <article><span>Provider</span><strong>{snapshot?.config.providers.length ?? 0}</strong></article>
          <article><span>账号</span><strong>{snapshot?.config.accounts.length ?? 0}</strong></article>
          <article><span>模型列表</span><strong>{modelNames}</strong></article>
          <article><span>运行态账号</span><strong>{snapshot?.runtimeStates.length ?? 0}</strong></article>
        </div>
      </section>

      <section className="panel import-panel">
        <div className="panel-header split">
          <TitleWithIcon icon="database" title="凭证导入" subtitle="同步 CLI Proxy API 的导入入口：OAuth、Token/JSON、API Key、批量导入。" />
        </div>
        <div className="import-tabs">
          {importTabs.map((tab) => (
            <button
              key={tab.id}
              className={`import-tab ${importMode === tab.id ? 'active' : ''}`}
              onClick={() => setImportMode(tab.id)}
            >
              <Icon name={tab.icon} />
              {tab.label}
            </button>
          ))}
        </div>
        <div className="import-body">
          {importMode === 'oauth' ? <p className="subtle">OAuth 授权入口已预留：后续可接 provider OAuth flow，授权成功后自动生成账号。</p> : null}
          {importMode === 'token-json' ? (
            <div className="bulk-import-box">
              <textarea rows={5} value={bulkImportText} onChange={(event) => setBulkImportText(event.target.value)} placeholder='粘贴账号 JSON、账号数组，或 {"providers":[],"accounts":[],"models":[]} 配置片段' />
              <button className="primary icon-button" disabled={!bulkImportText.trim()} onClick={applyTokenJsonImport}><Icon name="file" />应用 Token / JSON</button>
            </div>
          ) : null}
          {importMode === 'api-key' ? <p className="subtle">API Key 方式请使用下方“账号表单”，可填明文 API Key 或环境变量名。</p> : null}
          {importMode === 'import' ? <p className="subtle">批量导入支持 Token / JSON 配置片段；导入后先检查 JSON 区，再点“保存配置”。</p> : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header split"><TitleWithIcon icon="provider" title="平台表单" subtitle="添加或覆盖 provider，Grok/xAI、OpenRouter、Gemini 等都按 OpenAI-compatible 接入。" /></div>
        <div className="form-grid compact-form">
          <label><span>ID</span><input value={providerDraft.id} onChange={(e) => setProviderDraft({ ...providerDraft, id: e.target.value })} placeholder="xai" /></label>
          <label><span>名称</span><input value={providerDraft.label} onChange={(e) => setProviderDraft({ ...providerDraft, label: e.target.value })} placeholder="xAI / Grok" /></label>
          <label><span>Kind</span><select value={providerDraft.kind} onChange={(e) => setProviderDraft({ ...providerDraft, kind: e.target.value })}><option value="openai_compatible">openai_compatible</option><option value="custom_http">custom_http</option><option value="claude_web">claude_web</option></select></label>
          <label><span>Base URL</span><input value={providerDraft.baseUrl} onChange={(e) => setProviderDraft({ ...providerDraft, baseUrl: e.target.value })} placeholder="https://api.x.ai/v1" /></label>
          <label><span>默认代理</span><input value={providerDraft.defaultProxyId} onChange={(e) => setProviderDraft({ ...providerDraft, defaultProxyId: e.target.value })} placeholder="codex-us" /></label>
          <label><span>Timeout(ms)</span><input value={providerDraft.timeoutMs} onChange={(e) => setProviderDraft({ ...providerDraft, timeoutMs: e.target.value })} /></label>
          <label className="checkbox-field"><input type="checkbox" checked={providerDraft.enabled} onChange={(e) => setProviderDraft({ ...providerDraft, enabled: e.target.checked })} /><span>启用</span></label>
          <div className="button-row form-actions"><button className="primary icon-button" onClick={addProvider}><Icon name="provider" />添加/覆盖平台</button></div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header split"><TitleWithIcon icon="account" title="账号表单" subtitle="为指定 provider 添加 API Key 账号；可填明文 apiKey 或环境变量名。" /></div>
        <div className="form-grid compact-form">
          <label><span>ID</span><input value={accountDraft.id} onChange={(e) => setAccountDraft({ ...accountDraft, id: e.target.value })} placeholder="xai-main" /></label>
          <label><span>Provider</span><select value={accountDraft.providerId} onChange={(e) => setAccountDraft({ ...accountDraft, providerId: e.target.value })}><option value="">选择 provider</option>{providerIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
          <label><span>名称</span><input value={accountDraft.label} onChange={(e) => setAccountDraft({ ...accountDraft, label: e.target.value })} placeholder="Grok Main" /></label>
          <label><span>优先级</span><input value={accountDraft.priority} onChange={(e) => setAccountDraft({ ...accountDraft, priority: e.target.value })} /></label>
          <label><span>API Key</span><input type="password" value={accountDraft.apiKey} onChange={(e) => setAccountDraft({ ...accountDraft, apiKey: e.target.value })} placeholder="xai-..." /></label>
          <label><span>API Key Env</span><input value={accountDraft.apiKeyEnv} onChange={(e) => setAccountDraft({ ...accountDraft, apiKeyEnv: e.target.value })} placeholder="XAI_API_KEY" /></label>
          <label className="checkbox-field"><input type="checkbox" checked={accountDraft.enabled} onChange={(e) => setAccountDraft({ ...accountDraft, enabled: e.target.checked })} /><span>启用</span></label>
          <div className="button-row form-actions"><button className="primary icon-button" onClick={addAccount}><Icon name="account" />添加/覆盖账号</button></div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header split"><TitleWithIcon icon="route" title="模型路由表单" subtitle="普通模型填 provider/upstream；fallback 每行填 provider:model 或 provider:model:account1,account2。" /></div>
        <div className="form-grid compact-form">
          <label><span>模型 ID</span><input value={modelDraft.id} onChange={(e) => setModelDraft({ ...modelDraft, id: e.target.value })} placeholder="grok-4" /></label>
          <label><span>策略</span><select value={modelDraft.strategy} onChange={(e) => setModelDraft({ ...modelDraft, strategy: e.target.value })}><option value="round_robin">round_robin</option><option value="fallback">fallback</option></select></label>
          <label><span>Capability</span><select value={modelDraft.capability} onChange={(e) => setModelDraft({ ...modelDraft, capability: e.target.value as ModelCapability })}><option value="chat">chat</option><option value="image">image</option></select></label>
          <label><span>Provider</span><select value={modelDraft.providerId} disabled={modelDraft.strategy === 'fallback'} onChange={(e) => setModelDraft({ ...modelDraft, providerId: e.target.value })}><option value="">选择 provider</option>{providerIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
          <label><span>Upstream Model</span><input disabled={modelDraft.strategy === 'fallback'} value={modelDraft.upstreamModel} onChange={(e) => setModelDraft({ ...modelDraft, upstreamModel: e.target.value })} placeholder="grok-4" /></label>
          <label className="full-width"><span>Fallback Candidates</span><textarea rows={4} disabled={modelDraft.strategy !== 'fallback'} value={modelDraft.candidatesText} onChange={(e) => setModelDraft({ ...modelDraft, candidatesText: e.target.value })} placeholder="xai:grok-4&#10;openai:gpt-4.1&#10;deepseek:deepseek-chat" /></label>
          <div className="button-row form-actions"><button className="primary icon-button" onClick={addModel}><Icon name="route" />添加/覆盖模型</button></div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header split">
          <TitleWithIcon icon="config" title="配置 JSON" subtitle="表单会同步到 JSON；也可手动编辑 providers / accounts / models / proxies。" />
          <div className="button-row"><button className="secondary icon-button" disabled={busy || !status?.running} onClick={() => void reloadConfig()}><Icon name="refresh" />Reload</button><button className="ghost icon-button" disabled={busy || !status?.running} onClick={() => void resetRuntime()}><Icon name="status" />重置运行态</button><button className="primary icon-button" disabled={busy || !status?.running} onClick={() => void saveConfig()}><Icon name="save" />保存配置</button></div>
        </div>
        <textarea className="config-editor" rows={18} spellCheck={false} value={configText} onChange={(event) => setConfigText(event.target.value)} placeholder="启动多平台 API 服务后加载配置 JSON" />
      </section>

      <section className="panel">
        <div className="panel-header split"><TitleWithIcon icon="provider" title="平台列表" subtitle="启用的平台会参与模型路由；openai_compatible 可以直接反代。" /></div>
        <div className="table-shell"><table><thead><tr><th>状态</th><th>Provider</th><th>Kind</th><th>Base URL</th><th>默认代理</th><th>操作</th></tr></thead><tbody>
          {snapshot?.config.providers.length ? snapshot.config.providers.map((provider) => (
            <tr key={text(provider.id)}><td><span className={provider.enabled === false ? 'badge disabled' : 'badge healthy'}>{provider.enabled === false ? '禁用' : '启用'}</span></td><td><strong>{text(provider.label)}</strong><br /><code>{text(provider.id)}</code></td><td><code>{text(provider.kind)}</code></td><td><code>{text(provider.baseUrl)}</code></td><td><code>{text(provider.defaultProxyId, 'direct')}</code></td><td><button className="danger-text icon-button" onClick={() => removeConfigItem('providers', provider.id)}><Icon name="trash" />删除</button></td></tr>
          )) : <tr><td colSpan={6} className="empty-cell">暂无平台。</td></tr>}
        </tbody></table></div>
      </section>

      <section className="panel">
        <div className="panel-header split"><TitleWithIcon icon="account" title="账号池" subtitle="同平台多账号按优先级和轮询调度，限流后会进入 cooling_down。" /></div>
        <div className="table-shell"><table><thead><tr><th>账号</th><th>Provider</th><th>状态</th><th>优先级</th><th>运行态</th><th>操作</th></tr></thead><tbody>
          {snapshot?.config.accounts.length ? snapshot.config.accounts.map((account) => {
            const runtime = snapshot.runtimeStates.find((item) => item.accountId === account.id);
            const state = text(runtime?.status, account.enabled === false ? 'disabled' : 'healthy');
            return <tr key={text(account.id)}><td><strong>{text(account.label)}</strong><br /><code>{text(account.id)}</code></td><td><code>{text(account.providerId)}</code></td><td><span className={badgeClass(state)}>{state}</span></td><td>{text(account.priority, '0')}</td><td><div className="runtime-stack"><strong>今日调用 {text(runtime?.todayCalls, '0')}</strong>{runtime?.lastFailureKind ? <small>失败类型：{text(runtime.lastFailureKind)}</small> : null}{runtime?.lastStatusCode ? <small>状态码：{text(runtime.lastStatusCode)}</small> : null}{runtime?.lastError ? <small className="error-text">{text(runtime.lastError)}</small> : null}</div></td><td><button className="danger-text icon-button" onClick={() => removeConfigItem('accounts', account.id)}><Icon name="trash" />删除</button></td></tr>;
          }) : <tr><td colSpan={6} className="empty-cell">暂无账号。</td></tr>}
        </tbody></table></div>
      </section>

      <section className="panel">
        <div className="panel-header split"><TitleWithIcon icon="route" title="模型路由" subtitle="客户端模型名映射到真实 provider/model，并按 capability 分流到 chat 或 image。" /></div>
        <div className="table-shell"><table><thead><tr><th>模型</th><th>Capability</th><th>策略</th><th>直连</th><th>候选链</th><th>操作</th></tr></thead><tbody>
          {snapshot?.config.models.length ? snapshot.config.models.map((model) => (
            <tr key={text(model.id)}><td><strong>{text(model.id)}</strong></td><td>{capabilityBadges(model)}</td><td><code>{text(model.strategy)}</code></td><td><code>{text(model.providerId)} {text(model.upstreamModel, '')}</code></td><td>{Array.isArray(model.candidates) ? candidatesToLines(model.candidates).split('\n').map((line) => <div key={line}><code>{line}</code></div>) : '—'}</td><td><button className="danger-text icon-button" onClick={() => removeConfigItem('models', model.id)}><Icon name="trash" />删除</button></td></tr>
          )) : <tr><td colSpan={6} className="empty-cell">暂无模型路由。</td></tr>}
        </tbody></table></div>
      </section>
    </main>
  );
}
