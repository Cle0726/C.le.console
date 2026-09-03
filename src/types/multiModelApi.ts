export type ModelCapability = 'text' | 'vision' | 'reasoning' | 'image' | 'video';

export interface MultiModelDefinition {
  id: string;
  alias: string;
  capabilities: ModelCapability[];
  enabled: boolean;
}

export interface MultiModelAccount {
  id: string;
  name: string;
  provider: string;
  authMode: 'api_key' | 'oauth_json';
  baseUrl: string;
  apiKey: string;
  credentialJson?: Record<string, unknown> | null;
  proxyUrl: string;
  prefix: string;
  priority: number;
  headers: Record<string, string>;
  models: MultiModelDefinition[];
  enabled: boolean;
  source: string;
}

export interface MultiModelApiKey {
  id: string;
  label: string;
  key: string;
  allowedModels: string[];
  excludedModels?: string[];
  accountIds?: string[];
  modelPrefix?: string;
  providerGateway?: Record<string, unknown> | null;
  source?: string;
  enabled: boolean;
}

export interface MultiModelApiConfig {
  enabled: boolean;
  port: number;
  accessScope: 'localhost' | 'lan';
  upstreamProxy: string;
  routingStrategy: 'round-robin' | 'fill-first';
  sessionAffinity: boolean;
  sessionAffinityTtl: string;
  requestRetries: number;
  debugLogs: boolean;
  apiKeys: MultiModelApiKey[];
  accounts: MultiModelAccount[];
}

export interface MultiModelCatalogEntry {
  provider: string;
  id: string;
  capabilities: ModelCapability[];
}

export interface MultiModelApiState {
  config: MultiModelApiConfig;
  running: boolean;
  baseUrl: string;
  lastError?: string | null;
  catalog: MultiModelCatalogEntry[];
  selfHeal?: MultiModelSelfHealState;
  xaiAccounts?: XaiAccountUsage[];
  accountUsages?: MultiModelAccountUsage[];
}

export interface MultiModelUsageBucket {
  id: string;
  label: string;
  remainingPercent: number;
  resetAt?: string | null;
}

export interface MultiModelAccountUsage {
  accountId: string;
  updatedAt?: string | null;
  status: string;
  buckets: MultiModelUsageBucket[];
}

export interface XaiQuotaBucket {
  id: string;
  label: string;
  used?: number | null;
  total?: number | null;
  remaining?: number | null;
  usedPercent?: number | null;
  resetAt?: string | null;
}

export interface XaiAccountUsage {
  accountId: string;
  email: string;
  plan?: string | null;
  status: 'normal' | 'pending' | 'reauth_required' | 'error' | string;
  statusReason?: string | null;
  hasGrokCodeAccess?: boolean | null;
  tokenExpiresAt?: string | null;
  updatedAt: string;
  buckets: XaiQuotaBucket[];
}

export interface XaiOAuthStartResponse {
  loginId: string;
  verificationUri: string;
  verificationUriComplete?: string | null;
  userCode: string;
  expiresIn: number;
  intervalSeconds: number;
}

export interface MultiModelSelfHealState {
  status: 'idle' | 'healthy' | 'degraded' | 'recovering';
  consecutiveFailures: number;
  restartAttempts: number;
  restartFailures: number;
  lastSuccessAt?: string | null;
  lastRepairAt?: string | null;
  nextRestartAt?: string | null;
  lastError?: string | null;
}

export interface MultiModelApiTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  model: string;
  response: string;
  error?: string | null;
}

export type MultiModelRepairStatus = 'ok' | 'repaired' | 'warning' | 'error';

export interface MultiModelRepairCheck {
  id: string;
  label: string;
  status: MultiModelRepairStatus;
  detail: string;
  action?: string | null;
}

export interface MultiModelRepairReport {
  ok: boolean;
  repaired: number;
  restarted: boolean;
  checkedAt: string;
  durationMs: number;
  checks: MultiModelRepairCheck[];
  state: MultiModelApiState;
}
