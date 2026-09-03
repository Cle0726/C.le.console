import { invoke } from '@tauri-apps/api/core';
import type {
  MultiModelApiConfig,
  MultiModelApiState,
  MultiModelApiTestResult,
  MultiModelRepairReport,
  XaiOAuthStartResponse,
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
  openWindow: () => invoke<void>('multi_model_api_open_window'),
  getState: () => invoke<MultiModelApiState>('multi_model_api_get_state'),
  saveConfig: (config: MultiModelApiConfig) =>
    invoke<MultiModelApiState>('multi_model_api_save_config', { config }),
  setEnabled: (enabled: boolean) =>
    invoke<MultiModelApiState>('multi_model_api_set_enabled', { enabled }),
  syncManagedAccounts: () =>
    invoke<MultiModelApiState>('multi_model_api_sync_managed_accounts'),
  testChat: (model?: string, prompt?: string) =>
    invoke<MultiModelApiTestResult>('multi_model_api_test_chat', { model, prompt }),
  diagnoseAndRepair: (deep = true) =>
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
  genericOAuthStart: (request: MultiModelGenericOAuthStartRequest) =>
    invoke<MultiModelGenericOAuthStartResponse>('multi_model_api_generic_oauth_start', { request }),
  genericOAuthExchange: (request: MultiModelGenericOAuthExchangeRequest) =>
    invoke<Record<string, unknown>>('multi_model_api_generic_oauth_exchange', { request }),
};
