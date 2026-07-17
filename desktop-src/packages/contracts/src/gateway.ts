export type SessionAccountStatus = 'healthy' | 'cooling_down' | 'invalid' | 'disabled' | 'exhausted';
export type TransportMode = 'direct_http' | 'browser_bridge' | 'auto';
export type HelperMode = 'disabled' | 'probe_only' | 'browser_fetch' | 'page_context';
export type SessionFailureKind =
  | 'rate_limited'
  | 'invalid_session'
  | 'cloudflare_block'
  | 'risk_control_block'
  | 'network_error'
  | 'upstream_5xx'
  | 'upstream_4xx'
  | 'stream_parse_error'
  | 'helper_unavailable'
  | 'unknown';

export interface ClaudeSessionAccount {
  id: string;
  label: string;
  sessionKey: string;
  proxyUrl?: string;
  enabled: boolean;
  dailyLimit?: number;
}

export interface ClaudeSessionRuntimeState {
  accountId: string;
  status: SessionAccountStatus;
  todayCalls: number;
  cooldownUntil?: string | null;
  retryAfterUntil?: string | null;
  lastError?: string | null;
  lastSuccessAt?: string | null;
  lastFailureKind?: SessionFailureKind | null;
  lastStatusCode?: number | null;
  lastTransport?: TransportMode | null;
  consecutiveFailures?: number;
}

export interface GatewayConfig {
  enabled: boolean;
  listenHost: string;
  listenPort: number;
  upstreamBaseUrl?: string;
  transportMode: TransportMode;
  helperMode: HelperMode;
  probeBeforeStart: boolean;
  preferBrowserOn403: boolean;
  respectRetryAfter: boolean;
  streamFirstChunkTimeoutMs: number;
  maxRetries: number;
  cooldownMinutes: number;
  claudeDailyLimit: number;
  requireApiKey: boolean;
  localApiKey?: string;
  accounts: ClaudeSessionAccount[];
}

export interface GatewayStatus {
  running: boolean;
  listenHost: string;
  listenPort: number;
  apiBaseUrl: string;
  upstreamBaseUrl: string;
  transportMode: TransportMode;
  helperMode: HelperMode;
  supportsStreaming: boolean;
  sidecarPid?: number | null;
  lastError?: string | null;
  updatedAt: string;
}

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface BatchImportResult {
  inserted: number;
  skipped: number;
  items: ClaudeSessionAccount[];
}

export interface TestGatewayChatResult {
  ok: boolean;
  status: number;
  apiUrl: string;
  model: string;
  requestMessage: string;
  responseText?: string | null;
  rawBody: string;
}
