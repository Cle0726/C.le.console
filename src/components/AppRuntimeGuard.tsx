import React, { ErrorInfo, ReactNode, useEffect, useMemo, useState } from 'react';
import i18n from '../i18n';

type GuardFailureCode = 'render-crash' | 'chunk-load';

type GuardFailure = {
  code: GuardFailureCode;
  message: string;
  detail?: string;
};

type AppRuntimeGuardProps = {
  children: ReactNode;
};

type RenderCrashBoundaryProps = {
  children: ReactNode;
};

type RenderCrashBoundaryState = {
  failure: GuardFailure | null;
};

const CHUNK_RECOVERY_STORAGE_KEY = 'cle:runtime:chunk-recovery';
const CHUNK_RECOVERY_QUERY_KEY = '__cle_recover';
const CHUNK_RECOVERY_WINDOW_MS = 2 * 60 * 1000;
const CHUNK_RECOVERY_STABLE_MS = 30 * 1000;

function normalizeErrorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name || 'error';
  }
  if (typeof value === 'string') {
    return value.trim() || 'error';
  }
  if (value === null || value === undefined) {
    return 'error';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isLikelyChunkLoadFailure(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('chunkloaderror') ||
    normalized.includes('loading chunk') ||
    normalized.includes('failed to fetch dynamically imported module') ||
    normalized.includes('importing a module script failed') ||
    normalized.includes('dynamic import')
  );
}

function scheduleChunkRecovery(): boolean {
  const now = Date.now();
  try {
    const previous = Number(window.sessionStorage.getItem(CHUNK_RECOVERY_STORAGE_KEY) || '0');
    if (Number.isFinite(previous) && previous > 0 && now - previous < CHUNK_RECOVERY_WINDOW_MS) {
      return false;
    }
    window.sessionStorage.setItem(CHUNK_RECOVERY_STORAGE_KEY, String(now));
  } catch {
    return false;
  }

  window.setTimeout(() => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set(CHUNK_RECOVERY_QUERY_KEY, String(now));
    window.location.replace(nextUrl.toString());
  }, 40);
  return true;
}

function scheduleRecoveryGuardCleanup(): () => void {
  const currentUrl = new URL(window.location.href);
  if (!currentUrl.searchParams.has(CHUNK_RECOVERY_QUERY_KEY)) {
    return () => undefined;
  }
  const timer = window.setTimeout(() => {
    try {
      window.sessionStorage.removeItem(CHUNK_RECOVERY_STORAGE_KEY);
    } catch {
      // Storage can be unavailable in hardened webviews; the URL marker still prevents ambiguity.
    }
    currentUrl.searchParams.delete(CHUNK_RECOVERY_QUERY_KEY);
    window.history.replaceState(window.history.state, '', currentUrl.toString());
  }, CHUNK_RECOVERY_STABLE_MS);
  return () => window.clearTimeout(timer);
}

function createFallbackMessage(rawMessage: string): string {
  const action = i18n.t('common.appName', 'C.le.控制台');
  return i18n.t('messages.actionFailed', {
    action,
    error: rawMessage || 'error',
    defaultValue: '{{action}} failed: {{error}}',
  });
}

function GuardFallback({ failure }: { failure: GuardFailure }) {
  const title = i18n.t('common.failed', 'Failed');
  const refreshLabel = i18n.t('common.refresh', 'Refresh');
  const detailLabel = i18n.t('common.detail', 'Details');
  const message = useMemo(() => createFallbackMessage(failure.message), [failure.message]);
  const detailText = failure.detail?.trim();

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--bg-primary, #f8fafc)',
        color: 'var(--text-primary, #0f172a)',
      }}
    >
      <div
        style={{
          width: 'min(680px, calc(100vw - 32px))',
          borderRadius: 12,
          border: '1px solid var(--border, rgba(148, 163, 184, 0.28))',
          background: 'var(--bg-card, #ffffff)',
          boxShadow: '0 12px 32px rgba(2, 6, 23, 0.08)',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary, #475569)' }}>
          {message}
        </div>
        {detailText ? (
          <div
            style={{
              borderRadius: 10,
              border: '1px solid var(--border-light, rgba(148, 163, 184, 0.2))',
              background: 'var(--bg-tertiary, rgba(248, 250, 252, 0.8))',
              padding: 10,
              fontSize: 12,
              lineHeight: 1.5,
              color: 'var(--text-secondary, #475569)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            <strong>{detailLabel}: </strong>
            {detailText}
          </div>
        ) : null}
        <div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => window.location.reload()}
          >
            {refreshLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

class RenderCrashBoundary extends React.Component<RenderCrashBoundaryProps, RenderCrashBoundaryState> {
  state: RenderCrashBoundaryState = {
    failure: null,
  };

  static getDerivedStateFromError(error: Error): RenderCrashBoundaryState {
    return {
      failure: {
        code: 'render-crash',
        message: normalizeErrorMessage(error),
        detail: error?.stack || '',
      },
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const nextFailure: GuardFailure = {
      code: 'render-crash',
      message: normalizeErrorMessage(error),
      detail: [error?.stack, errorInfo.componentStack].filter(Boolean).join('\n'),
    };
    this.setState({ failure: nextFailure });
    console.error('[AppRuntimeGuard] Render crash captured:', error, errorInfo);
  }

  render() {
    if (this.state.failure) {
      return <GuardFallback failure={this.state.failure} />;
    }
    return this.props.children;
  }
}

export function AppRuntimeGuard({ children }: AppRuntimeGuardProps) {
  const [chunkFailure, setChunkFailure] = useState<GuardFailure | null>(null);

  useEffect(() => {
    let recoveryScheduled = false;
    const cleanupRecoveryGuard = scheduleRecoveryGuardCleanup();

    const recoverOrShowFailure = (failure: GuardFailure) => {
      if (!recoveryScheduled && scheduleChunkRecovery()) {
        recoveryScheduled = true;
        console.warn('[AppRuntimeGuard] stale frontend chunk detected; automatic recovery scheduled');
        return;
      }
      setChunkFailure(failure);
    };

    const handleWindowError = (event: ErrorEvent) => {
      const text = `${event.message || ''} ${event.error?.message || ''}`.trim();
      if (!isLikelyChunkLoadFailure(text)) {
        return;
      }
      recoverOrShowFailure({
        code: 'chunk-load',
        message: normalizeErrorMessage(event.error || event.message),
        detail: [event.filename, event.error?.stack].filter(Boolean).join('\n'),
      });
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const text = normalizeErrorMessage(event.reason);
      if (!isLikelyChunkLoadFailure(text)) {
        return;
      }
      recoverOrShowFailure({
        code: 'chunk-load',
        message: text,
        detail: text,
      });
    };

    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);
    return () => {
      cleanupRecoveryGuard();
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  if (chunkFailure) {
    return <GuardFallback failure={chunkFailure} />;
  }

  return <RenderCrashBoundary>{children}</RenderCrashBoundary>;
}
