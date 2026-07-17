export type AuthStatusValue = 'idle' | 'starting' | 'probe' | 'probe_error' | 'authenticated' | 'unauthenticated' | 'error';

export interface AuthExportStatus {
  version: number;
  status: AuthStatusValue;
  authenticated: boolean;
  exportedAt?: string;
  userDataDir?: string;
  cookieNames?: string[];
  hasSessionKey?: boolean;
  hasLastActiveOrg?: boolean;
  url?: string | null;
  error?: string | null;
}

export interface ClaudeWebProfileExport {
  version: number;
  source: string;
  exportedAt: string;
  userDataDir: string;
  cookies: Array<{
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
  }>;
  webProfile?: unknown;
}
