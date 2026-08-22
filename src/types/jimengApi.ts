export type JimengRegion = 'cn' | 'us' | 'hk' | 'jp' | 'sg';

export interface JimengAccount {
  id: string;
  name: string;
  region: JimengRegion;
  authMethod: 'session' | 'oauthDevice';
  sessionId: string;
  oauthHome: string;
  proxyUrl: string;
  priority: number;
  enabled: boolean;
}

export interface JimengApiConfig {
  enabled: boolean;
  port: number;
  debugLogs: boolean;
  accounts: JimengAccount[];
}

export interface JimengModel {
  id: string;
  kind: 'image' | 'video';
  regions: JimengRegion[];
}

export interface JimengApiState {
  config: JimengApiConfig;
  running: boolean;
  baseUrl: string;
  version: string;
  lastError?: string | null;
  models: JimengModel[];
  selfHeal?: JimengSelfHealState;
}

export interface JimengSelfHealState {
  status: 'idle' | 'healthy' | 'degraded' | 'recovering' | string;
  consecutiveFailures: number;
  restartAttempts: number;
  restartFailures: number;
  lastSuccessAt?: string | null;
  lastRepairAt?: string | null;
  nextRestartAt?: string | null;
  lastError?: string | null;
}

export interface JimengMediaRequest {
  accountId?: string | null;
  payload: Record<string, unknown>;
  imagePaths?: string[];
  videoPaths?: string[];
}

export interface JimengRepairReport {
  ok: boolean;
  restarted: boolean;
  checks: Array<{
    id: string;
    status: 'ok' | 'warning' | 'error';
    detail: string;
  }>;
  state: JimengApiState;
}

export interface JimengDeviceFlow {
  flowId: string;
  accountId: string;
  verificationUri: string;
  userCode: string;
  expiresAt: string;
  pollInterval: number;
  status: 'pending' | 'authorized' | 'expired' | 'failed';
  message?: string;
  account?: JimengAccount;
}

export interface DoubaoWebAccountState {
  id: string;
  name: string;
  platformId: WebCreatorPlatformId;
  enabled: boolean;
  busy: boolean;
  windowOpen: boolean;
  loggedIn: boolean;
  statusVerified: boolean;
  currentUrl?: string | null;
  message: string;
  lastError?: string | null;
  consecutiveFailures: number;
}

export type WebCreatorPlatformId = 'doubao' | 'jimeng' | 'qianwen' | 'xiaoyunque' | 'douyin';

export interface WebCreatorPlatform {
  id: WebCreatorPlatformId;
  name: string;
  shortName: string;
  description: string;
  homeUrl: string;
  capabilities: string[];
}

export interface DoubaoWebState {
  platforms: WebCreatorPlatform[];
  accounts: DoubaoWebAccountState[];
  selectedAccountId?: string | null;
  message: string;
}

export interface DoubaoWebVideoRequest {
  accountId?: string | null;
  prompt: string;
  ratio: '1:1' | '16:9' | '9:16';
}

export interface WebCreatorBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible?: boolean;
}

export interface WebCreatorWorkspaceState {
  activeAccountId?: string | null;
  currentUrl?: string | null;
  visible: boolean;
}

export interface WebCreatorAsset {
  id: string;
  url: string;
  cleanUrl: string;
  kind: 'image' | 'video' | string;
  source: string;
  title: string;
  platform: string;
  discoveredAt: number;
}

export interface WebCreatorDownloadResult {
  path: string;
  bytes: number;
  usedCleanUrl: boolean;
}
