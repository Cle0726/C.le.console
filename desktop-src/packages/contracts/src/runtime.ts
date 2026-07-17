import type { AuthExportStatus } from './auth';
import type { GatewayConfig, GatewayStatus, ClaudeSessionRuntimeState, ModelInfo } from './gateway';

export interface ErrorPayload {
  error: {
    message: string;
    type: string;
    code?: string;
    details?: unknown;
  };
}

export interface GatewaySnapshot {
  config: GatewayConfig;
  status: GatewayStatus;
  runtimeStates: ClaudeSessionRuntimeState[];
  authStatus: AuthExportStatus | null;
  models: ModelInfo[];
}
