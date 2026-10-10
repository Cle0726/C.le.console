import { invoke } from '@tauri-apps/api/core';
import type {
  MultiModelApiConfig,
  MultiModelApiState,
  MultiModelApiTestResult,
  MultiModelRepairReport,
  MultiModelQuotaRefreshResult,
  XaiOAuthStartResponse,
  DoubaoWorkCliModels,
} from '../types/multiModelApi';

export interface MultiModelGenericOAuthStartRequest {
  authorizationUrl: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  extraAuthorizeParams?: Record<string, string>;
}

export interface MultiModelGenericOAuthStartResponse {
  authUrl: string;
  state: string;
  codeVerifier: string;
}

export interface MultiModelGenericOAuthExchangeRequest {
  provider: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  callbackOrCode: string;
  codeVerifier?: string;
  expectedState?: string;
  extraTokenParams?: Record<string, string>;
}

export const multiModelApiService = {
  extensionRequest: <T = Record<string, unknown>>(method: string, path: string, body?: unknown) =>
    invoke<T>('extension_provider_request', { method, path, body: body ?? null }),
  startExtensionLogin: (provider: string, edition: string, name: string) =>
    invoke<{ state: string; authUrl: string; hosted: boolean }>('extension_provider_login_start', { provider, edition, name }),
  openExtensionLogin: (state: string) => invoke<void>('extension_provider_login_open', { state }),
  finishExtensionLogin: (state: string, cancel = false) => invoke<void>('extension_provider_login_finish', { state, cancel }),
  syncExtensionAccounts: () => invoke<MultiModelApiState>('multi_model_api_sync_extension_accounts'),
  openWindow: () => invoke<void>('multi_model_api_open_window'),
  getState: () => invoke<MultiModelApiState>('multi_model_api_get_state'),
  saveConfig: (config: MultiModelApiConfig) =>
    invoke<MultiModelApiState>('multi_model_api_save_config', { config }),
  setEnabled: (enabled: boolean) =>
    invoke<MultiModelApiState>('multi_model_api_set_enabled', { enabled }),
  syncManagedAccounts: () =>
    invoke<MultiModelApiState>('multi_model_api_sync_managed_accounts'),
  syncWorkbuddyAccounts: () =>
    invoke<MultiModelApiState>('multi_model_api_sync_workbuddy_accounts'),
  syncUpstreamModels: () =>
    invoke<MultiModelApiState>('multi_model_api_sync_upstream_models'),
  doubaoWorkModels: () =>
    invoke<DoubaoWorkCliModels>('multi_model_api_doubao_work_models'),
  testChat: (model?: string, prompt?: string) =>
    invoke<MultiModelApiTestResult>('multi_model_api_test_chat', { model, prompt }),
  diagnoseAndRepair: (deep = false) =>
    invoke<MultiModelRepairReport>('multi_model_api_diagnose_and_repair', { deep }),
  startXaiOAuth: () =>
    invoke<XaiOAuthStartResponse>('multi_model_api_xai_oauth_start'),
  completeXaiOAuth: (loginId: string) =>
    invoke<MultiModelApiState>('multi_model_api_xai_oauth_complete', { loginId }),
  cancelXaiOAuth: (loginId?: string | null) =>
    invoke<void>('multi_model_api_xai_oauth_cancel', { loginId: loginId ?? null }),
  importLocalXaiAccounts: () =>
    invoke<MultiModelApiState>('multi_model_api_import_local_xai_accounts'),
  importXaiAccountsJson: (jsonContent: string) =>
    invoke<MultiModelApiState>('multi_model_api_import_xai_accounts_json', { jsonContent }),
  refreshXaiAccounts: (forceCredentials = false) =>
    invoke<MultiModelApiState>('multi_model_api_refresh_xai_accounts', { forceCredentials }),
  refreshQuotas: (provider?: string, accountIds?: string[]) =>
    invoke<MultiModelQuotaRefreshResult>('multi_model_api_refresh_quotas', { provider, accountIds }),
  genericOAuthStart: (request: MultiModelGenericOAuthStartRequest) =>
    invoke<MultiModelGenericOAuthStartResponse>('multi_model_api_generic_oauth_start', { request }),
  genericOAuthExchange: (request: MultiModelGenericOAuthExchangeRequest) =>
    invoke<Record<string, unknown>>('multi_model_api_generic_oauth_exchange', { request }),
};
