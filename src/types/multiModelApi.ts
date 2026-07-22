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
}

export interface MultiModelApiTestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  model: string;
  response: string;
  error?: string | null;
}
