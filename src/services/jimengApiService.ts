import { invoke } from '@tauri-apps/api/core';
import type {
  JimengApiConfig,
  JimengApiState,
  JimengDeviceFlow,
  JimengMediaRequest,
  JimengRepairReport,
  DoubaoWebState,
  DoubaoWebVideoRequest,
  DoubaoDesktopImportResult,
  DoubaoDesktopScan,
  DoubaoCredentialExportResult,
  DoubaoCredentialImportResult,
  WebCreatorAsset,
  WebCreatorBounds,
  WebCreatorDownloadResult,
  WebCreatorWorkspaceState,
} from '../types/jimengApi';

const isJimengVisualReview =
  typeof window !== 'undefined' &&
  ['127.0.0.1', 'localhost'].includes(window.location.hostname) &&
  ['jimeng', 'jimeng-canvas'].includes(
    new URLSearchParams(window.location.search).get('visual-review') ?? '',
  );

const visualReviewState: JimengApiState = {
  config: {
    enabled: true,
    port: 15100,
    debugLogs: false,
    accounts: [
      {
        id: 'visual-review-account',
        name: '即梦主账号',
        region: 'cn',
        authMethod: 'session',
        sessionId: 'visual-review-session',
        oauthHome: '',
        proxyUrl: '',
        priority: 10,
        enabled: true,
      },
    ],
  },
  running: true,
  baseUrl: 'http://127.0.0.1:15100/v1',
  version: '1.6.3',
  lastError: null,
  models: [
    { id: 'jimeng-4.5', kind: 'image', regions: ['cn', 'us'] },
    { id: 'jimeng-4.1', kind: 'image', regions: ['cn', 'us'] },
    { id: 'seedance-1.5-pro', kind: 'video', regions: ['cn', 'us'] },
    { id: 'veo-3.1', kind: 'video', regions: ['us'] },
  ],
};

export const jimengApiService = {
  getState: () =>
    isJimengVisualReview
      ? Promise.resolve(structuredClone(visualReviewState))
      : invoke<JimengApiState>('jimeng_api_get_state'),
  saveConfig: (config: JimengApiConfig) =>
    invoke<JimengApiState>('jimeng_api_save_config', { config }),
  setEnabled: (enabled: boolean) =>
    invoke<JimengApiState>('jimeng_api_set_enabled', { enabled }),
  accountAction: (action: 'check' | 'points' | 'receive', accountId?: string) =>
    invoke<unknown>('jimeng_api_account_action', { action, accountId: accountId ?? null }),
  generateImage: (request: JimengMediaRequest) =>
    invoke<Record<string, unknown>>('jimeng_api_generate_image', { request }),
  composeImage: (request: JimengMediaRequest) =>
    invoke<Record<string, unknown>>('jimeng_api_compose_image', { request }),
  generateVideo: (request: JimengMediaRequest) =>
    invoke<Record<string, unknown>>('jimeng_api_generate_video', { request }),
  diagnoseAndRepair: () =>
    invoke<JimengRepairReport>('jimeng_api_diagnose_and_repair'),
  startDeviceFlow: (accountId: string, accountName: string, region: string) =>
    invoke<JimengDeviceFlow>('jimeng_api_start_device_flow', { accountId, accountName, region }),
  pollDeviceFlow: (flowId: string) =>
    invoke<JimengDeviceFlow>('jimeng_api_poll_device_flow', { flowId }),
  cancelDeviceFlow: (flowId: string) =>
    invoke<void>('jimeng_api_cancel_device_flow', { flowId }),
  getDoubaoWebState: (selectedAccountId?: string | null) =>
    invoke<DoubaoWebState>('doubao_web_get_state', { selectedAccountId: selectedAccountId ?? null }),
  addDoubaoWebAccount: (platformId = 'doubao', name?: string) =>
    invoke<DoubaoWebState>('doubao_web_add_account', { platformId, name: name || null }),
  scanDoubaoDesktopProfiles: () =>
    invoke<DoubaoDesktopScan>('doubao_desktop_scan'),
  importDoubaoDesktopProfiles: (profileDirs: string[]) =>
    invoke<DoubaoDesktopImportResult>('doubao_desktop_import', { profileDirs }),
  exportDoubaoCredentials: (accountIds?: string[]) =>
    invoke<DoubaoCredentialExportResult>('doubao_credentials_export', { accountIds: accountIds?.length ? accountIds : null }),
  importDoubaoCredentials: (json: string) =>
    invoke<DoubaoCredentialImportResult>('doubao_credentials_import', { json }),
  setDoubaoWebAccountEnabled: (accountId: string, enabled: boolean) =>
    invoke<DoubaoWebState>('doubao_web_set_account_enabled', { accountId, enabled }),
  renameDoubaoWebAccount: (accountId: string, name: string) =>
    invoke<DoubaoWebState>('doubao_web_rename_account', { accountId, name }),
  removeDoubaoWebAccount: (accountId: string) =>
    invoke<DoubaoWebState>('doubao_web_remove_account', { accountId }),
  openDoubaoWebLogin: (accountId: string) =>
    invoke<DoubaoWebState>('doubao_web_open_login', { accountId }),
  logoutDoubaoWeb: (accountId: string) =>
    invoke<DoubaoWebState>('doubao_web_logout', { accountId }),
  generateDoubaoWebVideo: (request: DoubaoWebVideoRequest) =>
    invoke<Record<string, unknown>>('doubao_web_generate_video', { request }),
  openWebCreatorWindow: () =>
    isJimengVisualReview ? Promise.resolve() : invoke<void>('web_creator_open_window'),
  openWebCreatorAccount: (accountId: string, bounds?: WebCreatorBounds) =>
    invoke<WebCreatorWorkspaceState>('web_creator_open_account', { accountId, bounds: bounds ?? null }),
  setWebCreatorBounds: (bounds: WebCreatorBounds) =>
    invoke<WebCreatorWorkspaceState>('web_creator_set_bounds', { bounds }),
  hideWebCreator: () =>
    invoke<WebCreatorWorkspaceState>('web_creator_hide'),
  detachWebCreatorAccount: (accountId?: string | null) =>
    invoke<WebCreatorWorkspaceState>('web_creator_detach_account', { accountId: accountId ?? null }),
  navigateWebCreator: (action: 'back' | 'forward' | 'reload') =>
    invoke<WebCreatorWorkspaceState>('web_creator_navigate', { action }),
  navigateWebCreatorTo: (url: string) =>
    invoke<WebCreatorWorkspaceState>('web_creator_navigate_to', { url }),
  getWebCreatorState: () =>
    invoke<WebCreatorWorkspaceState>('web_creator_get_state'),
  collectWebCreatorAssets: (accountId?: string | null) =>
    invoke<WebCreatorAsset[]>('web_creator_collect_assets', { accountId: accountId ?? null }),
  clearWebCreatorAssets: (accountId?: string | null) =>
    invoke<void>('web_creator_clear_assets', { accountId: accountId ?? null }),
  downloadWebCreatorAsset: (asset: WebCreatorAsset, accountId?: string | null) =>
    invoke<WebCreatorDownloadResult>('web_creator_download_asset', { asset, accountId: accountId ?? null }),
};
