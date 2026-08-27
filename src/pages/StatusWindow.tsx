import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTranslation } from 'react-i18next';
import { CompactStatusPanel, type CompactRouteItem } from '../components/CompactStatusPanel';
import {
  EGRESS_SOURCE_DEFINITIONS,
  deriveEgressVerdict,
} from '../data/egressMonitor';
import { buildCodexAccountPresentation } from '../presentation/platformAccountPresentation';
import {
  getNetworkEgressSnapshot,
  type NetworkEgressSnapshot,
  type NetworkEgressSourceSnapshot,
} from '../services/networkEgressService';
import { hideStatusWindow } from '../services/statusWindowService';
import { useCodexAccountStore } from '../stores/useCodexAccountStore';
import {
  applyVisualTheme,
  readVisualTheme,
  saveVisualTheme,
  VISUAL_THEME_STORAGE_KEY,
  type VisualTheme,
} from '../utils/visualTheme';
import {
  applyPerformanceMode,
  readPerformanceMode,
  savePerformanceMode,
  PERFORMANCE_MODE_STORAGE_KEY,
  type PerformanceMode,
} from '../utils/performanceMode';
import './StatusWindow.css';

export function StatusWindow() {
  const { t } = useTranslation();
  const { currentAccount, fetchAccounts, fetchCurrentAccount, refreshQuota } = useCodexAccountStore();
  const [theme, setTheme] = useState<VisualTheme>(() => readVisualTheme());
  const [performanceMode, setPerformanceMode] = useState<PerformanceMode>(() => readPerformanceMode());
  const [checkedAt, setCheckedAt] = useState(() => new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [egressError, setEgressError] = useState<string | null>(null);
  const [egressSnapshot, setEgressSnapshot] = useState<NetworkEgressSnapshot | null>(null);
  const egressInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const loadEgressSnapshot = useCallback(async () => {
    if (egressInFlightRef.current) return null;
    egressInFlightRef.current = true;
    try {
      const nextSnapshot = await getNetworkEgressSnapshot();
      if (mountedRef.current) {
        setEgressSnapshot(nextSnapshot);
        setEgressError(null);
        setCheckedAt(new Date(nextSnapshot.capturedAt));
      }
      return nextSnapshot;
    } catch (error) {
      if (mountedRef.current) {
        setEgressError(`代理检测不可用 / DETECTION UNAVAILABLE · ${String(error)}`);
      }
      throw error;
    } finally {
      egressInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('status-window-root');
    document.body.classList.add('status-window-root');
    document.getElementById('root')?.classList.add('status-window-root');
    return () => {
      document.documentElement.classList.remove('status-window-root');
      document.body.classList.remove('status-window-root');
      document.getElementById('root')?.classList.remove('status-window-root');
    };
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    const syncTheme = () => {
      const nextTheme = readVisualTheme();
      const nextPerformanceMode = readPerformanceMode();
      setTheme(nextTheme);
      setPerformanceMode(nextPerformanceMode);
      applyVisualTheme(nextTheme);
      applyPerformanceMode(nextPerformanceMode);
    };
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === VISUAL_THEME_STORAGE_KEY
        || event.key === PERFORMANCE_MODE_STORAGE_KEY
      ) syncTheme();
    };
    const handleVisibility = () => {
      if (!document.hidden) syncTheme();
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener('focus', syncTheme);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', syncTheme);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  useEffect(() => {
    void Promise.allSettled([fetchAccounts(), fetchCurrentAccount()]);
  }, [fetchAccounts, fetchCurrentAccount]);

  useEffect(() => {
    void loadEgressSnapshot().catch(() => undefined);
    const interval = window.setInterval(() => {
      if (!document.hidden) void loadEgressSnapshot().catch(() => undefined);
    }, 8_000);
    return () => window.clearInterval(interval);
  }, [loadEgressSnapshot]);

  const presentation = useMemo(
    () => currentAccount ? buildCodexAccountPresentation(currentAccount, t) : null,
    [currentAccount, t],
  );

  const routeItems = useMemo<CompactRouteItem[]>(() => EGRESS_SOURCE_DEFINITIONS.map((source) => {
    const observation = egressSnapshot?.sources.find((item) => item.id === source.id) ?? {
      id: source.id,
      observationState: 'not_observed',
      processNames: [],
      routes: [],
      nodes: [],
      rules: [],
      activeConnections: 0,
      downloadBytes: 0,
      uploadBytes: 0,
      publicIp: null,
    } satisfies NetworkEgressSourceSnapshot;
    const verdict = deriveEgressVerdict(source, observation);
    return {
      id: source.id,
      label: source.label,
      short: source.short,
      expectedRoute: source.expectedRoute,
      actualRoute: verdict.actualRoute,
      rule: verdict.actualRule,
      status: verdict.health,
    };
  }), [egressSnapshot]);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    const quotaTask = async () => {
      await fetchCurrentAccount();
      const account = useCodexAccountStore.getState().currentAccount;
      if (account) await refreshQuota(account.id);
    };
    const [quotaResult, egressResult] = await Promise.allSettled([
      quotaTask(),
      loadEgressSnapshot(),
    ]);
    const failures = [quotaResult, egressResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => String(result.reason));
    if (failures.length > 0) {
      setRefreshError(`部分刷新失败 / PARTIAL REFRESH · ${failures.join(' · ')}`);
    } else {
      setCheckedAt(new Date());
    }
    setRefreshing(false);
  }, [fetchCurrentAccount, loadEgressSnapshot, refreshQuota, refreshing]);

  const handleToggleTheme = useCallback(() => {
    const nextTheme: VisualTheme = theme === 'night' ? 'day' : 'night';
    setTheme(nextTheme);
    saveVisualTheme(nextTheme);
  }, [theme]);

  const handleTogglePerformanceMode = useCallback(() => {
    const nextMode: PerformanceMode = performanceMode === 'lite' ? 'full' : 'lite';
    setPerformanceMode(nextMode);
    savePerformanceMode(nextMode);
  }, [performanceMode]);

  const handleRestoreWindow = useCallback(() => {
    void hideStatusWindow().catch((error) => {
      console.error('[StatusWindow] 恢复主窗口失败:', error);
    });
  }, []);

  const handleClose = useCallback(() => {
    void hideStatusWindow().catch(() => getCurrentWindow().hide());
  }, []);

  const handleDragStart = useCallback((event?: ReactMouseEvent<HTMLElement>) => {
    if (event && event.button !== 0) return;
    event?.preventDefault();
    event?.stopPropagation();
    void getCurrentWindow().startDragging();
  }, []);

  const handleWindowMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('[data-tauri-drag-region]')) return;
    if (target.closest('[data-status-window-no-drag="true"], button, input, select, textarea, a, [role="button"]')) return;
    handleDragStart(event);
  }, [handleDragStart]);

  return (
    <div className="status-window" onMouseDown={handleWindowMouseDown}>
      <CompactStatusPanel
        accountLabel="Codex"
        planLabel={presentation?.planLabel || '--'}
        quotaItems={(presentation?.quotaItems || []).slice(0, 2).map((item) => ({
          key: item.key,
          label: item.label,
          percentage: item.percentage,
          resetText: item.resetText,
        }))}
        routeItems={routeItems}
        checkedAt={checkedAt}
        theme={theme}
        performanceMode={performanceMode}
        refreshing={refreshing}
        refreshError={refreshError ?? egressError}
        onRefresh={() => void handleRefresh()}
        onRestoreWindow={handleRestoreWindow}
        onTogglePerformanceMode={handleTogglePerformanceMode}
        onToggleTheme={handleToggleTheme}
        onClose={handleClose}
      />
    </div>
  );
}
