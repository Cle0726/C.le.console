import { invoke } from '@tauri-apps/api/core';
import type {
  AuthExportStatus,
  BatchImportResult,
  ClaudeSessionAccount,
  GatewayConfig,
  GatewaySnapshot,
  GatewayStatus,
  ModelInfo,
  TestGatewayChatResult,
} from '@desktop/contracts';

export interface MultiProxyStatus {
  running: boolean;
  pid?: number | null;
  apiBaseUrl: string;
  uiUrl: string;
  health?: Record<string, unknown> | null;
  lastError?: string | null;
}

export interface MultiProxyTestResult {
  ok: boolean;
  status: number;
  rawBody: string;
  responseText?: string | null;
  gateway?: Record<string, unknown> | null;
}

export type MultiProxyImageApiMode = 'images' | 'responses';

export interface MultiProxyImagePreview {
  url?: string | null;
  b64Json?: string | null;
  dataUrl?: string | null;
  revisedPrompt?: string | null;
}

export interface MultiProxyImageTestResult {
  ok: boolean;
  status: number;
  apiMode: MultiProxyImageApiMode;
  images: MultiProxyImagePreview[];
  gateway?: Record<string, unknown> | null;
  debugBodyPreview: string;
}

export interface MultiProxySnapshot {
  health: Record<string, unknown>;
  config: {
    listenHost: string;
    listenPort: number;
    defaultModel: string;
    providers: Array<Record<string, unknown>>;
    accounts: Array<Record<string, unknown>>;
    models: Array<Record<string, unknown>>;
    proxies: Array<Record<string, unknown>>;
  };
  runtimeStates: Array<Record<string, unknown>>;
}

const SAMPLE_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';
const SAMPLE_IMAGE_DATA_URL = `data:image/png;base64,${SAMPLE_IMAGE_BASE64}`;

const mockMultiProxyStatus: MultiProxyStatus = {
  running: true,
  pid: 13978,
  apiBaseUrl: 'http://127.0.0.1:13978/v1',
  uiUrl: 'http://127.0.0.1:13978/',
  health: {
    ok: true,
    service: 'multi-platform-proxy-api',
    providers: 4,
    accounts: 3,
    models: 6,
    runtimeStates: 2,
  },
  lastError: null,
};

const mockMultiProxySnapshot: MultiProxySnapshot = {
  health: mockMultiProxyStatus.health ?? {},
  config: {
    listenHost: '127.0.0.1',
    listenPort: 13978,
    defaultModel: 'coding-auto',
    providers: [
      { id: 'mock-a', label: 'Mock Platform A', kind: 'openai_compatible', enabled: true, baseUrl: 'http://127.0.0.1:19081/v1' },
      { id: 'mock-b', label: 'Mock Platform B', kind: 'openai_compatible', enabled: true, baseUrl: 'http://127.0.0.1:19082/v1' },
      { id: 'openai', label: 'OpenAI', kind: 'openai_compatible', enabled: false, baseUrl: 'https://api.openai.com/v1' },
      { id: 'deepseek', label: 'DeepSeek', kind: 'openai_compatible', enabled: false, baseUrl: 'https://api.deepseek.com/v1' },
    ],
    accounts: [
      { id: 'mock-a-1', providerId: 'mock-a', label: 'Mock A Account 1', enabled: true, priority: 10 },
      { id: 'mock-a-2', providerId: 'mock-a', label: 'Mock A Account 2', enabled: true, priority: 9 },
      { id: 'mock-b-1', providerId: 'mock-b', label: 'Mock B Account 1', enabled: true, priority: 8 },
    ],
    models: [
      { id: 'mock-a-chat', providerId: 'mock-a', upstreamModel: 'mock-a-model', strategy: 'round_robin', capabilities: ['chat'] },
      { id: 'mock-b-chat', providerId: 'mock-b', upstreamModel: 'mock-b-model', strategy: 'round_robin', capabilities: ['chat'] },
      { id: 'mock-a-image', providerId: 'mock-a', upstreamModel: 'mock-a-image-model', strategy: 'round_robin', capabilities: ['image'] },
      { id: 'mock-b-image', providerId: 'mock-b', upstreamModel: 'mock-b-image-model', strategy: 'round_robin', capabilities: ['image'] },
      { id: 'coding-auto', strategy: 'fallback', capabilities: ['chat'], candidates: [{ providerId: 'mock-a', model: 'mock-a-model' }, { providerId: 'mock-b', model: 'mock-b-model' }] },
      { id: 'image-auto', strategy: 'fallback', capabilities: ['image'], candidates: [{ providerId: 'mock-a', model: 'mock-a-image-model' }, { providerId: 'mock-b', model: 'mock-b-image-model' }] },
    ],
    proxies: [{ id: 'direct', label: 'DIRECT', type: 'direct' }],
  },
  runtimeStates: [
    { accountId: 'mock-a-1', providerId: 'mock-a', status: 'cooling_down', todayCalls: 0, lastFailureKind: 'rate_limited', lastStatusCode: 429 },
    { accountId: 'mock-a-2', providerId: 'mock-a', status: 'healthy', todayCalls: 2, lastStatusCode: 200 },
  ],
};

const mockState: GatewaySnapshot = {
  config: {
    enabled: false,
    listenHost: '127.0.0.1',
    listenPort: 8787,
    upstreamBaseUrl: 'https://claude.ai',
    transportMode: 'direct_http',
    helperMode: 'probe_only',
    probeBeforeStart: false,
    preferBrowserOn403: true,
    respectRetryAfter: true,
    streamFirstChunkTimeoutMs: 8000,
    maxRetries: 3,
    cooldownMinutes: 15,
    claudeDailyLimit: 100,
    requireApiKey: false,
    localApiKey: '',
    accounts: [],
  },
  status: {
    running: false,
    listenHost: '127.0.0.1',
    listenPort: 8787,
    apiBaseUrl: 'http://127.0.0.1:8787/v1',
    upstreamBaseUrl: 'https://claude.ai',
    transportMode: 'direct_http',
    helperMode: 'probe_only',
    supportsStreaming: true,
    sidecarPid: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
  },
  runtimeStates: [],
  authStatus: null,
  models: [
    { id: 'claude-sonnet-5', object: 'model', created: 0, owned_by: 'claude-web' },
    { id: 'claude-haiku-4-5', object: 'model', created: 0, owned_by: 'claude-web' },
    { id: 'claude-3-7-sonnet-latest', object: 'model', created: 0, owned_by: 'claude-web' },
    { id: 'claude-3-5-haiku-latest', object: 'model', created: 0, owned_by: 'claude-web' },
  ],
};

function canInvokeTauri() {
  const tauriWindow = window as Window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
  return Boolean(tauriWindow.__TAURI__ || tauriWindow.__TAURI_INTERNALS__);
}

function refreshMockStatus(overrides: Partial<GatewayStatus> = {}) {
  mockState.status = {
    ...mockState.status,
    listenHost: mockState.config.listenHost,
    listenPort: mockState.config.listenPort,
    apiBaseUrl: `http://${mockState.config.listenHost}:${mockState.config.listenPort}/v1`,
    upstreamBaseUrl: mockState.config.upstreamBaseUrl ?? 'https://claude.ai',
    transportMode: mockState.config.transportMode,
    helperMode: mockState.config.helperMode,
    supportsStreaming: true,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function mockInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  switch (command) {
    case 'get_gateway_snapshot':
      refreshMockStatus();
      return structuredClone(mockState) as T;
    case 'save_gateway_config': {
      mockState.config = structuredClone(args?.config as GatewayConfig);
      refreshMockStatus();
      return structuredClone(mockState) as T;
    }
    case 'start_gateway':
      mockState.config.enabled = true;
      refreshMockStatus({ running: true, sidecarPid: 4242, lastError: null });
      return structuredClone(mockState.status) as T;
    case 'stop_gateway':
      mockState.config.enabled = false;
      refreshMockStatus({ running: false, sidecarPid: null });
      return structuredClone(mockState.status) as T;
    case 'launch_claude_login': {
      const auth: AuthExportStatus = {
        version: 1,
        status: 'authenticated',
        authenticated: true,
        exportedAt: new Date().toISOString(),
        userDataDir: 'mock-user-data',
        cookieNames: ['sessionKey', 'lastActiveOrg'],
        hasSessionKey: true,
        hasLastActiveOrg: true,
        url: 'https://claude.ai/',
        error: null,
      };
      mockState.authStatus = auth;
      return structuredClone(auth) as T;
    }
    case 'get_auth_status':
      return structuredClone(mockState.authStatus) as T;
    case 'list_gateway_models':
      return structuredClone(mockState.models) as T;
    case 'test_gateway_chat': {
      const message = String(args?.message ?? '你好');
      return {
        ok: mockState.status.running,
        status: mockState.status.running ? 200 : 503,
        apiUrl: `${mockState.status.apiBaseUrl}/chat/completions`,
        model: String(args?.model ?? 'claude-sonnet-5'),
        requestMessage: message,
        responseText: mockState.status.running ? `mock: ${message}` : null,
        rawBody: mockState.status.running ? JSON.stringify({ choices: [{ message: { role: 'assistant', content: `mock: ${message}` } }] }) : 'gateway not running',
      } as T;
    }
    case 'import_session_keys': {
      const raw = String(args?.raw ?? '');
      const values = raw
        .split(/[\n,]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      let inserted = 0;
      let skipped = 0;
      const known = new Set(mockState.config.accounts.map((account) => account.sessionKey));
      for (const sessionKey of values) {
        if (known.has(sessionKey)) {
          skipped += 1;
          continue;
        }
        inserted += 1;
        known.add(sessionKey);
        mockState.config.accounts.push({
          id: `acct_${Math.random().toString(36).slice(2, 10)}`,
          label: `Claude Web ${mockState.config.accounts.length + 1}`,
          sessionKey,
          enabled: true,
          proxyUrl: '',
          dailyLimit: mockState.config.claudeDailyLimit,
        });
      }
      return {
        inserted,
        skipped,
        items: structuredClone(mockState.config.accounts),
      } as T;
    }
    case 'get_multi_proxy_status':
      return structuredClone(mockMultiProxyStatus) as T;
    case 'start_multi_proxy':
      mockMultiProxyStatus.running = true;
      mockMultiProxyStatus.pid = 13978;
      return structuredClone(mockMultiProxyStatus) as T;
    case 'stop_multi_proxy':
      mockMultiProxyStatus.running = false;
      mockMultiProxyStatus.pid = null;
      return structuredClone(mockMultiProxyStatus) as T;
    case 'get_multi_proxy_snapshot':
      return structuredClone(mockMultiProxySnapshot) as T;
    case 'save_multi_proxy_config':
      mockMultiProxySnapshot.config = structuredClone(args?.config as MultiProxySnapshot['config']);
      return structuredClone(mockMultiProxySnapshot) as T;
    case 'reload_multi_proxy':
      return structuredClone(mockMultiProxySnapshot) as T;
    case 'reset_multi_proxy_runtime':
      mockMultiProxySnapshot.runtimeStates = [];
      return structuredClone(mockMultiProxySnapshot) as T;
    case 'test_multi_proxy_chat':
      return {
        ok: true,
        status: 200,
        rawBody: JSON.stringify({ choices: [{ message: { content: 'mock multi proxy ok' } }] }),
        responseText: 'mock multi proxy ok',
        gateway: { providerId: 'mock-a', accountId: 'mock-a-2', upstreamModel: 'mock-a-model' },
      } as T;
    case 'test_multi_proxy_image': {
      const prompt = String(args?.prompt ?? '小猫');
      const apiMode = String(args?.apiMode ?? 'images') as MultiProxyImageApiMode;
      return {
        ok: true,
        status: 200,
        apiMode,
        images: [{
          b64Json: SAMPLE_IMAGE_BASE64,
          dataUrl: SAMPLE_IMAGE_DATA_URL,
          revisedPrompt: `mock: ${prompt}`,
        }],
        gateway: { providerId: 'mock-b', accountId: 'mock-b-1', upstreamModel: apiMode === 'responses' ? 'mock-b-image-model' : 'mock-b-image-model' },
        debugBodyPreview: JSON.stringify({ apiMode, prompt, output: ['mock image'] }),
      } as T;
    }
    default:
      throw new Error(`Mock invoke does not implement command: ${command}`);
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!canInvokeTauri()) {
    return mockInvoke<T>(command, args);
  }
  return invoke<T>(command, args);
}

export const desktopApi = {
  async getGatewaySnapshot(): Promise<GatewaySnapshot> {
    return call<GatewaySnapshot>('get_gateway_snapshot');
  },

  async saveGatewayConfig(config: GatewayConfig): Promise<GatewaySnapshot> {
    return call<GatewaySnapshot>('save_gateway_config', { config });
  },

  async importSessionKeys(raw: string): Promise<BatchImportResult> {
    return call<BatchImportResult>('import_session_keys', { raw });
  },

  async startGateway(): Promise<GatewayStatus> {
    return call<GatewayStatus>('start_gateway');
  },

  async stopGateway(): Promise<GatewayStatus> {
    return call<GatewayStatus>('stop_gateway');
  },

  async launchClaudeLogin(): Promise<AuthExportStatus> {
    return call<AuthExportStatus>('launch_claude_login');
  },

  async refreshAuthStatus(): Promise<AuthExportStatus | null> {
    return call<AuthExportStatus | null>('get_auth_status');
  },

  async listModels(): Promise<ModelInfo[]> {
    return call<ModelInfo[]>('list_gateway_models');
  },

  async testGatewayChat(message: string, model = 'claude-sonnet-5'): Promise<TestGatewayChatResult> {
    return call<TestGatewayChatResult>('test_gateway_chat', { message, model });
  },

  async getMultiProxyStatus(): Promise<MultiProxyStatus> {
    return call<MultiProxyStatus>('get_multi_proxy_status');
  },

  async startMultiProxy(): Promise<MultiProxyStatus> {
    return call<MultiProxyStatus>('start_multi_proxy');
  },

  async stopMultiProxy(): Promise<MultiProxyStatus> {
    return call<MultiProxyStatus>('stop_multi_proxy');
  },

  async getMultiProxySnapshot(adminToken = 'local-admin-token'): Promise<MultiProxySnapshot> {
    return call<MultiProxySnapshot>('get_multi_proxy_snapshot', { adminToken });
  },

  async saveMultiProxyConfig(config: MultiProxySnapshot['config'], adminToken = 'local-admin-token'): Promise<MultiProxySnapshot> {
    return call<MultiProxySnapshot>('save_multi_proxy_config', { adminToken, config });
  },

  async reloadMultiProxy(adminToken = 'local-admin-token'): Promise<MultiProxySnapshot> {
    return call<MultiProxySnapshot>('reload_multi_proxy', { adminToken });
  },

  async resetMultiProxyRuntime(adminToken = 'local-admin-token'): Promise<MultiProxySnapshot> {
    return call<MultiProxySnapshot>('reset_multi_proxy_runtime', { adminToken });
  },

  async testMultiProxyChat(message: string, model = 'coding-auto'): Promise<MultiProxyTestResult> {
    return call<MultiProxyTestResult>('test_multi_proxy_chat', { message, model });
  },

  async testMultiProxyImage({
    apiMode = 'images',
    model = 'image-auto',
    prompt,
    size,
    quality,
    background,
    n,
  }: {
    apiMode?: MultiProxyImageApiMode;
    model?: string;
    prompt: string;
    size?: string;
    quality?: string;
    background?: string;
    n?: number;
  }): Promise<MultiProxyImageTestResult> {
    return call<MultiProxyImageTestResult>('test_multi_proxy_image', { apiMode, model, prompt, size, quality, background, n });
  },
};

export function maskSessionKey(sessionKey: string): string {
  if (sessionKey.length <= 10) {
    return sessionKey;
  }
  return `${sessionKey.slice(0, 6)}••••${sessionKey.slice(-4)}`;
}

export function cloneAccount(account: ClaudeSessionAccount): ClaudeSessionAccount {
  return { ...account };
}
