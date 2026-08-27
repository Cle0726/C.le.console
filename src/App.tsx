import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from 'react';
import './App.css';
/* Deliberately imported after App.css so the unified material layer wins over
   legacy page styles without relying on invalid late CSS @import rules. */
import './styles/ui-unified-2026.css';
import './styles/liquid-glass-26.css';
/* Authoritative material system — tiered glass, canvas, motion and cost
   control. Must stay last: it corrects the page stylesheets that lazily-loaded
   pages inject at runtime. */
import './styles/liquid-glass-system.css';
import './styles/responsive-text-safety.css';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { FileText, FolderOpen, RefreshCw, X } from 'lucide-react';
import { SideNav } from './components/layout/SideNav';
import { IndustrialChrome } from './components/layout/IndustrialChrome';
import { AmbientInteractionLayer } from './components/AmbientInteractionLayer';
import { PetFishCursorLayer } from './components/PetFishCursorLayer';
import { SignatureCursorLayer } from './components/SignatureCursorLayer';
import { StartupPerformanceProvider } from './contexts/StartupPerformanceContext';
import { GlobalModal } from './components/GlobalModal';
import type { QuickSettingsType } from './components/QuickSettingsPopover';
import type { Page } from './types/navigation';
import { useAutoRefresh } from './hooks/useAutoRefresh';
import { useEasterEggTrigger } from './hooks/useEasterEggTrigger';
import { useGlobalModal } from './hooks/useGlobalModal';
import { changeLanguage, getCurrentLanguage, normalizeLanguage, syncLanguage } from './i18n';
import { useAccountStore } from './stores/useAccountStore';
import { useCodexAccountStore } from './stores/useCodexAccountStore';
import { useClaudeAccountStore } from './stores/useClaudeAccountStore';
import { useGitHubCopilotAccountStore } from './stores/useGitHubCopilotAccountStore';
import { useWindsurfAccountStore } from './stores/useWindsurfAccountStore';
import { useKiroAccountStore } from './stores/useKiroAccountStore';
import { useCursorAccountStore } from './stores/useCursorAccountStore';
import { useGeminiAccountStore } from './stores/useGeminiAccountStore';
import { useCodebuddyAccountStore } from './stores/useCodebuddyAccountStore';
import { useCodebuddyCnAccountStore } from './stores/useCodebuddyCnAccountStore';
import { useQoderAccountStore } from './stores/useQoderAccountStore';
import { useTraeAccountStore } from './stores/useTraeAccountStore';
import { useWorkbuddyAccountStore } from './stores/useWorkbuddyAccountStore';
import { useZedAccountStore } from './stores/useZedAccountStore';
import { useSideNavLayoutStore } from './stores/useSideNavLayoutStore';
import { usePlatformLayoutStore } from './stores/usePlatformLayoutStore';
import { FloatingCardWindow } from './pages/FloatingCardWindow';
import { StatusWindow } from './pages/StatusWindow';
import { initWakeupNotificationListener } from './utils/wakeupNotificationListener';
import { loadWakeupOfficialLsVersionMode } from './utils/wakeupOfficialLsVersion';
import {
  dispatchExternalProviderImportEvent,
  normalizeExternalProviderImportPayload,
  type ExternalProviderImportPayload,
} from './utils/externalProviderImport';
import { runAutoBackupCycle } from './services/scheduledBackupService';
import { readPerformanceMode } from './utils/performanceMode';
import { normalizeUiScale, reflectUiScale } from './utils/uiScale';

const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })),
);
const AccountsPage = lazy(() =>
  import('./pages/AccountsPage').then((module) => ({ default: module.AccountsPage })),
);
const CodexAccountsPage = lazy(() =>
  import('./pages/CodexAccountsPage').then((module) => ({ default: module.CodexAccountsPage })),
);
const CodexApiServicePage = lazy(() =>
  import('./pages/CodexApiServicePage').then((module) => ({ default: module.CodexApiServicePage })),
);
const MultiModelApiServicePage = lazy(() =>
  import('./pages/MultiModelApiServicePage').then((module) => ({ default: module.MultiModelApiServicePage })),
);
const JimengApiServicePage = lazy(() =>
  import('./pages/JimengApiServicePage').then((module) => ({ default: module.JimengApiServicePage })),
);
const JimengInfiniteCanvasPage = lazy(() =>
  import('./pages/JimengInfiniteCanvasPage').then((module) => ({ default: module.JimengInfiniteCanvasPage })),
);
const ClaudeWebApiPage = lazy(() =>
  import('./pages/ClaudeWebApiPage').then((module) => ({ default: module.ClaudeWebApiPage })),
);
const ClaudeAccountsPage = lazy(() =>
  import('./pages/ClaudeAccountsPage').then((module) => ({ default: module.ClaudeAccountsPage })),
);
const GitHubCopilotAccountsPage = lazy(() =>
  import('./pages/GitHubCopilotAccountsPage').then((module) => ({
    default: module.GitHubCopilotAccountsPage,
  })),
);
const WindsurfAccountsPage = lazy(() =>
  import('./pages/WindsurfAccountsPage').then((module) => ({ default: module.WindsurfAccountsPage })),
);
const KiroAccountsPage = lazy(() =>
  import('./pages/KiroAccountsPage').then((module) => ({ default: module.KiroAccountsPage })),
);
const CursorAccountsPage = lazy(() =>
  import('./pages/CursorAccountsPage').then((module) => ({ default: module.CursorAccountsPage })),
);
const GeminiAccountsPage = lazy(() =>
  import('./pages/GeminiAccountsPage').then((module) => ({ default: module.GeminiAccountsPage })),
);
const CodebuddyAccountsPage = lazy(() =>
  import('./pages/CodebuddyAccountsPage').then((module) => ({ default: module.CodebuddyAccountsPage })),
);
const CodebuddyCnAccountsPage = lazy(() =>
  import('./pages/CodebuddyCnAccountsPage').then((module) => ({ default: module.CodebuddyCnAccountsPage })),
);
const QoderAccountsPage = lazy(() =>
  import('./pages/QoderAccountsPage').then((module) => ({ default: module.QoderAccountsPage })),
);
const TraeAccountsPage = lazy(() =>
  import('./pages/TraeAccountsPage').then((module) => ({ default: module.TraeAccountsPage })),
);
const WorkbuddyAccountsPage = lazy(() =>
  import('./pages/WorkbuddyAccountsPage').then((module) => ({ default: module.WorkbuddyAccountsPage })),
);
const ZedAccountsPage = lazy(() =>
  import('./pages/ZedAccountsPage').then((module) => ({ default: module.ZedAccountsPage })),
);;
const WakeupTasksPage = lazy(() =>
  import('./pages/WakeupTasksPage').then((module) => ({ default: module.WakeupTasksPage })),
);
const WakeupVerificationPage = lazy(() =>
  import('./pages/WakeupVerificationPage').then((module) => ({
    default: module.WakeupVerificationPage,
  })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const TwoFactorAuthPage = lazy(() =>
  import('./pages/TwoFactorAuthPage').then((module) => ({ default: module.TwoFactorAuthPage })),
);
const ManualPage = lazy(() =>
  import('./pages/ManualPage').then((module) => ({ default: module.ManualPage })),
);
const InstancesPage = lazy(() =>
  import('./pages/InstancesPage').then((module) => ({ default: module.InstancesPage })),
);
const PlatformLayoutModal = lazy(() =>
  import('./components/PlatformLayoutModal').then((module) => ({
    default: module.PlatformLayoutModal,
  })),
);
const CloseConfirmDialog = lazy(() =>
  import('./components/CloseConfirmDialog').then((module) => ({ default: module.CloseConfirmDialog })),
);
const BreakoutModal = lazy(() =>
  import('./components/easter-egg/BreakoutModal').then((module) => ({ default: module.BreakoutModal })),
);
const LogViewerModal = lazy(() =>
  import('./components/LogViewerModal').then((module) => ({ default: module.LogViewerModal })),
);

interface GeneralConfigTheme {
  theme: string;
  ui_scale?: number;
}

interface GeneralConfigLanguage {
  language: string;
}

interface GeneralConfig extends GeneralConfigTheme, GeneralConfigLanguage {
  opencode_app_path: string;
  antigravity_app_path: string;
  codex_app_path: string;
  codex_launch_on_switch: boolean;
  vscode_app_path: string;
  windsurf_app_path: string;
  kiro_app_path: string;
  cursor_app_path: string;
  claude_app_path: string;
  claude_app_scan_roots: string;
  codebuddy_app_path: string;
  codebuddy_cn_app_path: string;
  qoder_app_path: string;
  trae_app_path: string;
  trae_solo_app_path: string;
  trae_cn_app_path: string;
  trae_solo_cn_app_path: string;
  trae_app_scan_roots: string;
  trae_solo_app_scan_roots: string;
  trae_cn_app_scan_roots: string;
  trae_solo_cn_app_scan_roots: string;
  workbuddy_app_path: string;
  zed_app_path: string;
}

type AppPathMissingDetail = {
  app:
    | 'antigravity'
    | 'codex'
    | 'claude'
    | 'vscode'
    | 'windsurf'
    | 'kiro'
    | 'cursor'
    | 'codebuddy'
    | 'codebuddy_cn'
    | 'qoder'
    | 'trae'
    | 'trae_solo'
    | 'trae_cn'
    | 'trae_solo_cn'
    | 'workbuddy'
    | 'zed';
  retry?:
    | { kind: 'default'; runtimeTarget?: string }
    | { kind: 'instance'; instanceId?: string; runtimeTarget?: string }
    | { kind: 'switchAccount'; accountId?: string; runtimeTarget?: string };
};

type AppLaunchCandidate = {
  target_type: string;
  label: string;
  target: string;
  source: string;
  supports_multi_instance: boolean;
};

function isClaudeWindowsAppLaunchTarget(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('shell:appsfolder\\') || trimmed.startsWith('shell:appsfolder/');
}

const WAKEUP_ENABLED_KEY = 'agtools.wakeup.enabled';
const TASKS_STORAGE_KEY = 'agtools.wakeup.tasks';
const WAKEUP_FORCE_DISABLE_MIGRATION_KEY = 'agtools.wakeup.migration.force_disable_0_8_14';

function isTraePlatformApp(app: string): app is 'trae' | 'trae_solo' | 'trae_cn' | 'trae_solo_cn' {
  return app === 'trae' || app === 'trae_solo' || app === 'trae_cn' || app === 'trae_solo_cn';
}

type TraePlatformApp = 'trae' | 'trae_solo' | 'trae_cn' | 'trae_solo_cn';

function getTraeAppPath(config: GeneralConfig, app: TraePlatformApp): string {
  switch (app) {
    case 'trae_solo':
      return config.trae_solo_app_path;
    case 'trae_cn':
      return config.trae_cn_app_path;
    case 'trae_solo_cn':
      return config.trae_solo_cn_app_path;
    case 'trae':
    default:
      return config.trae_app_path;
  }
}

function getTraeAppScanRoots(config: GeneralConfig, app: TraePlatformApp): string {
  switch (app) {
    case 'trae_solo':
      return config.trae_solo_app_scan_roots;
    case 'trae_cn':
      return config.trae_cn_app_scan_roots;
    case 'trae_solo_cn':
      return config.trae_solo_cn_app_scan_roots;
    case 'trae':
    default:
      return config.trae_app_scan_roots;
  }
}
const EXTERNAL_IMPORT_DEDUPE_WINDOW_MS = 30 * 1000;

type WakeupHistoryRecord = {
  id: string;
  timestamp: number;
  triggerType: string;
  triggerSource: string;
  taskName?: string;
  accountEmail: string;
  modelId: string;
  prompt?: string;
  success: boolean;
  message?: string;
  duration?: number;
};

type WakeupTaskResultPayload = {
  taskId: string;
  lastRunAt: number;
  records: WakeupHistoryRecord[];
};

type QuotaAlertPayload = {
  platform?: string;
  current_account_id: string;
  current_email: string;
  threshold: number;
  threshold_display?: string | null;
  lowest_percentage: number;
  low_models: string[];
  recommended_account_id?: string | null;
  recommended_email?: string | null;
  triggered_at: number;
};

type QuotaAlertPlatform =
  | 'antigravity'
  | 'codex'
  | 'claude'
  | 'github_copilot'
  | 'windsurf'
  | 'kiro'
  | 'cursor'
  | 'gemini'
  | 'codebuddy'
  | 'codebuddy_cn'
  | 'qoder'
  | 'trae'
  | 'workbuddy'
  | 'zed';
function buildExternalImportDedupeKey(payload: {
  providerId: string;
  page: string;
  token: string;
  importUrl?: string | null;
  apiBaseUrl?: string | null;
  minAppVersion?: string | null;
  rawUrl?: string | null;
}): string {
  return [
    payload.providerId,
    payload.page,
    payload.rawUrl ?? '',
    payload.importUrl ?? '',
    payload.apiBaseUrl ?? '',
    payload.minAppVersion ?? '',
    payload.token,
  ].join('|');
}

function parseVersionParts(value: string | null | undefined): number[] {
  if (!value) return [];
  return value
    .trim()
    .replace(/^v/i, '')
    .split(/[^\d]+/)
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part) && part >= 0);
}

function isVersionLowerThan(currentVersion: string, minimumVersion: string): boolean {
  const currentParts = parseVersionParts(currentVersion);
  const minimumParts = parseVersionParts(minimumVersion);
  if (currentParts.length === 0 || minimumParts.length === 0) {
    return false;
  }
  const maxLength = Math.max(currentParts.length, minimumParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const current = currentParts[index] ?? 0;
    const minimum = minimumParts[index] ?? 0;
    if (current < minimum) return true;
    if (current > minimum) return false;
  }
  return false;
}

function normalizeQuotaAlertPlatform(platform: string | undefined): QuotaAlertPlatform {
  switch (platform) {
    case 'codex':
      return 'codex';
    case 'claude':
    case 'claude-cli':
      return 'claude';
    case 'github_copilot':
      return 'github_copilot';
    case 'windsurf':
      return 'windsurf';
    case 'kiro':
      return 'kiro';
    case 'cursor':
      return 'cursor';
    case 'gemini':
      return 'gemini';
    case 'codebuddy':
      return 'codebuddy';
    case 'codebuddy_cn':
      return 'codebuddy_cn';
    case 'qoder':
      return 'qoder';
    case 'trae':
    case 'trae-solo':
    case 'trae_solo':
    case 'trae-cn':
    case 'trae_cn':
    case 'trae-solo-cn':
    case 'trae_solo_cn':
      return 'trae';
    case 'zed':
      return 'zed';
    default:
      return 'antigravity';
  }
}

function getQuotaAlertPlatformLabel(
  platform: QuotaAlertPlatform,
  t: (key: string, defaultValue: string) => string,
): string {
  switch (platform) {
    case 'codex':
      return t('nav.codex', 'Codex');
    case 'claude':
      return t('nav.claude', 'Claude');
    case 'github_copilot':
      return t('nav.githubCopilot', 'GitHub Copilot');
    case 'windsurf':
      return 'Windsurf';
    case 'kiro':
      return 'Kiro';
    case 'cursor':
      return 'Cursor';
    case 'gemini':
      return 'Gemini Cli';
    case 'codebuddy':
      return 'CodeBuddy';
    case 'codebuddy_cn':
      return t('nav.codebuddyCn', 'CodeBuddy CN');
    case 'qoder':
      return t('nav.qoder', 'Qoder');
    case 'trae':
      return t('nav.trae', 'Trae');
    case 'zed':
      return t('nav.zed', 'Zed');
    default:
      return t('nav.overview', 'Antigravity IDE');
  }
}

function getQuotaAlertTargetPage(platform: QuotaAlertPlatform): Page {
  switch (platform) {
    case 'codex':
      return 'codex';
    case 'claude':
      return 'claude';
    case 'github_copilot':
      return 'github-copilot';
    case 'windsurf':
      return 'windsurf';
    case 'kiro':
      return 'kiro';
    case 'cursor':
      return 'cursor';
    case 'gemini':
      return 'gemini';
    case 'codebuddy':
      return 'codebuddy';
    case 'codebuddy_cn':
      return 'codebuddy-cn';
    case 'qoder':
      return 'qoder';
    case 'trae':
      return 'trae';
    case 'workbuddy':
      return 'workbuddy';
    case 'zed':
      return 'zed';
    default:
      return 'overview';
  }
}

function getQuotaAlertQuickSettingsType(platform: QuotaAlertPlatform): QuickSettingsType {
  switch (platform) {
    case 'codex':
      return 'codex';
    case 'claude':
      return 'claude';
    case 'github_copilot':
      return 'github_copilot';
    case 'windsurf':
      return 'windsurf';
    case 'kiro':
      return 'kiro';
    case 'cursor':
      return 'cursor';
    case 'gemini':
      return 'gemini';
    case 'codebuddy':
      return 'codebuddy';
    case 'codebuddy_cn':
      return 'codebuddy_cn';
    case 'qoder':
      return 'qoder';
    case 'trae':
      return 'trae';
    case 'workbuddy':
      return 'workbuddy';
    case 'zed':
      return 'zed';
    default:
      return 'antigravity';
  }
}

function isElementVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

function triggerPageRefreshButton(): boolean {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button.btn.btn-secondary.icon-only:not(:disabled)'),
  );

  const target = buttons.find((button) => {
    if (!isElementVisible(button)) {
      return false;
    }
    return !!button.querySelector('svg.lucide-refresh-cw');
  });

  if (!target) {
    return false;
  }

  target.click();
  return true;
}

function isWindowsPlatform(): boolean {
  const navWithUAData = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = navWithUAData.userAgentData?.platform || navigator.platform || '';
  return platform.toLowerCase().includes('win');
}

function isMacOSPlatform(): boolean {
  const navWithUAData = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = navWithUAData.userAgentData?.platform || navigator.platform || '';
  return platform.toLowerCase().includes('mac');
}

function MainApp({ startupReady }: { startupReady: boolean }) {
  const { t } = useTranslation();
  const sideNavLayoutMode = useSideNavLayoutStore((state) => state.mode);
  const sideNavClassicCollapsed = useSideNavLayoutStore((state) => state.classicCollapsed);
  const sideNavClassicFirstSyncDone = useSideNavLayoutStore((state) => state.classicFirstSyncDone);
  const markSideNavClassicFirstSyncDone = useSideNavLayoutStore((state) => state.markClassicFirstSyncDone);
  const syncSidebarEntriesFromDashboard = usePlatformLayoutStore((state) => state.syncSidebarEntriesFromDashboard);
  // Every fresh main-window session starts from the dashboard. Runtime navigation
  // still uses setPage normally, but the last visited account page is no longer
  // restored on the next app launch.
  const [page, setPageState] = useState<Page>('dashboard');
  const pageRef = useRef<Page>('dashboard');
  const pageTransitionTimerRef = useRef<number | null>(null);
  const pageTransitionSequenceRef = useRef(0);
  const [pageTransitionPhase, setPageTransitionPhase] = useState<'idle' | 'entering-a' | 'entering-b'>('idle');
  const setPage = useCallback<Dispatch<SetStateAction<Page>>>((nextPage) => {
    const currentPage = pageRef.current;
    const targetPage = typeof nextPage === 'function' ? nextPage(currentPage) : nextPage;
    if (targetPage === currentPage) return;

    pageRef.current = targetPage;
    pageTransitionSequenceRef.current += 1;
    setPageTransitionPhase(pageTransitionSequenceRef.current % 2 === 0 ? 'entering-a' : 'entering-b');
    setPageState(targetPage);

    if (pageTransitionTimerRef.current !== null) {
      window.clearTimeout(pageTransitionTimerRef.current);
    }
    const duration = readPerformanceMode() === 'lite' ? 340 : 520;
    pageTransitionTimerRef.current = window.setTimeout(() => {
      setPageTransitionPhase('idle');
      pageTransitionTimerRef.current = null;
    }, duration);
  }, []);
  useEffect(() => () => {
    if (pageTransitionTimerRef.current !== null) {
      window.clearTimeout(pageTransitionTimerRef.current);
    }
  }, []);
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [showLogViewer, setShowLogViewer] = useState(false);
  const [showPlatformLayoutModal, setShowPlatformLayoutModal] = useState(false);
  const [platformLayoutRequestedGroupId, setPlatformLayoutRequestedGroupId] = useState<string | null>(null);
  const [showBreakout, setShowBreakout] = useState(false);
  const [hasBreakoutSession, setHasBreakoutSession] = useState(false);
  const [appPathMissing, setAppPathMissing] = useState<AppPathMissingDetail | null>(null);
  const [appPathSetting, setAppPathSetting] = useState(false);
  const [appPathDetecting, setAppPathDetecting] = useState(false);
  const [appPathDraft, setAppPathDraft] = useState('');
  const [appPathScanRootsDraft, setAppPathScanRootsDraft] = useState('');
  const [appLaunchCandidates, setAppLaunchCandidates] = useState<AppLaunchCandidate[]>([]);
  const [appPathActionError, setAppPathActionError] = useState('');
  const [appPathCodexLaunchOnSwitch, setAppPathCodexLaunchOnSwitch] = useState(true);
  const [appPathCodexLaunchSetting, setAppPathCodexLaunchSetting] = useState(false);
  const externalImportHandledAtRef = useRef<Map<string, number>>(new Map());
  const { showModal, closeModal } = useGlobalModal();
  const trayRefreshInFlightRef = useRef(false);
  const openPlatformLayoutModal = useCallback(() => {
    setPlatformLayoutRequestedGroupId(null);
    setShowPlatformLayoutModal(true);
  }, []);
  const openBreakout = useCallback(() => {
    setHasBreakoutSession(true);
    setShowBreakout(true);
  }, []);
  const ensureExternalImportVersionCompatible = useCallback(
    async (payload: ExternalProviderImportPayload): Promise<boolean> => {
      const requiredVersion = payload.minAppVersion?.trim().replace(/^v/i, '');
      if (!requiredVersion) return true;

      let currentVersion = '';
      try {
        currentVersion = await getVersion();
      } catch (error) {
        console.warn('[ExternalImport][App] 读取当前应用版本失败，已终止外部导入', error);
      }

      if (currentVersion && !isVersionLowerThan(currentVersion, requiredVersion)) {
        return true;
      }

      showModal({
        title: t('common.shared.externalImport.versionUnsupportedTitle', '应用版本过低'),
        description: t(
          'common.shared.externalImport.localBuildUnsupportedDesc',
          '当前本地构建暂不支持此导入方式。',
        ),
        width: 'sm',
        actions: [
          {
            id: 'close',
            label: t('common.close', '关闭'),
            variant: 'primary',
          },
        ],
      });
      console.warn('[ExternalImport][App] 当前版本不支持外部导入方式，已终止导入', {
        currentVersion: currentVersion || null,
        requiredVersion,
        providerId: payload.providerId,
      });
      return false;
    },
    [showModal, t],
  );

  const handleExternalProviderImportRawPayload = useCallback(async (rawPayload: unknown) => {
    console.info('[ExternalImport][App] 收到原始 payload:', rawPayload);
    const normalized = normalizeExternalProviderImportPayload(rawPayload);
    if (!normalized) {
      console.warn('[ExternalImport][App] payload 归一化失败，已忽略');
      return;
    }
    if (!(await ensureExternalImportVersionCompatible(normalized))) {
      return;
    }
    const now = Date.now();
    for (const [key, handledAt] of externalImportHandledAtRef.current) {
      if (now - handledAt > EXTERNAL_IMPORT_DEDUPE_WINDOW_MS) {
        externalImportHandledAtRef.current.delete(key);
      }
    }
    const dedupeKey = buildExternalImportDedupeKey(normalized);
    if (externalImportHandledAtRef.current.has(dedupeKey)) {
      console.info('[ExternalImport][App] 重复外部导入 payload 已忽略');
      return;
    }
    externalImportHandledAtRef.current.set(dedupeKey, now);
    console.info('[ExternalImport][App] payload 归一化成功:', {
      providerId: normalized.providerId,
      page: normalized.page,
      autoImport: normalized.autoImport,
      tokenLength: normalized.token.length,
      hasImportUrl: Boolean(normalized.importUrl),
      apiBaseUrl: normalized.apiBaseUrl ?? null,
      minAppVersion: normalized.minAppVersion ?? null,
      source: normalized.source ?? null,
    });
    setPage(normalized.page);
    window.setTimeout(() => {
      console.info('[ExternalImport][App] 分发前端外部导入事件');
      dispatchExternalProviderImportEvent(normalized);
    }, 0);
  }, [ensureExternalImportVersionCompatible]);
  const handleBreakoutMinimize = useCallback(() => {
    setShowBreakout(false);
  }, []);
  const handleBreakoutTerminate = useCallback(() => {
    setShowBreakout(false);
    setHasBreakoutSession(false);
  }, []);
  const handleResumeBreakout = useCallback(() => {
    if (!hasBreakoutSession) return;
    setShowBreakout(true);
  }, [hasBreakoutSession]);

  const {
    count: easterEggClickCount,
    registerClick: handleEasterEggTriggerClick,
    reset: resetEasterEggTrigger,
  } = useEasterEggTrigger({
    threshold: 20,
    windowMs: 8000,
    onTrigger: openBreakout,
  });
  const handleBreakoutEntryTriggerClick = useCallback(() => {
    if (hasBreakoutSession) {
      resetEasterEggTrigger();
      handleResumeBreakout();
      return;
    }
    handleEasterEggTriggerClick();
  }, [handleEasterEggTriggerClick, handleResumeBreakout, hasBreakoutSession, resetEasterEggTrigger]);
  
  // 启用自动刷新 hook
  useAutoRefresh();

  // 初始化唤醒通知监听器
  useEffect(() => {
    initWakeupNotificationListener();
  }, []);

  useEffect(() => {
    let disposed = false;

    const syncLanguageFromConfig = async () => {
      try {
        const config = await invoke<GeneralConfigLanguage>('get_general_config');
        const nextLanguage = await syncLanguage(config.language);
        if (disposed) {
          return;
        }
        window.dispatchEvent(
          new CustomEvent('general-language-updated', { detail: { language: nextLanguage } }),
        );
      } catch (error) {
        console.error('Failed to sync language config:', error);
      }
    };

    void syncLanguageFromConfig();
    window.addEventListener('config-updated', syncLanguageFromConfig);
    return () => {
      disposed = true;
      window.removeEventListener('config-updated', syncLanguageFromConfig);
    };
  }, []);

  useEffect(() => {
    const handleRefreshShortcut = (event: KeyboardEvent) => {
      const isRefreshKey = event.key.toLowerCase() === 'r';
      const isWindowsF5 = isWindowsPlatform() && event.key === 'F5';
      const hasMainModifier = event.metaKey || event.ctrlKey;
      const matchMainRefresh = isRefreshKey && hasMainModifier && !event.altKey && !event.shiftKey;
      const matchWindowsRefresh = isWindowsF5 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if ((!matchMainRefresh && !matchWindowsRefresh) || event.repeat) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      triggerPageRefreshButton();
    };

    window.addEventListener('keydown', handleRefreshShortcut, true);
    return () => {
      window.removeEventListener('keydown', handleRefreshShortcut, true);
    };
  }, []);

  useEffect(() => {
    if (sideNavLayoutMode !== 'classic' || sideNavClassicFirstSyncDone) {
      return;
    }
    syncSidebarEntriesFromDashboard();
    markSideNavClassicFirstSyncDone();
  }, [
    sideNavLayoutMode,
    sideNavClassicFirstSyncDone,
    syncSidebarEntriesFromDashboard,
    markSideNavClassicFirstSyncDone,
  ]);

  const openQuickSettingsForPlatform = useCallback((platform: QuotaAlertPlatform) => {
    const targetPage = getQuotaAlertTargetPage(platform);
    const targetType = getQuotaAlertQuickSettingsType(platform);
    closeModal();
    setPage(targetPage);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('quick-settings:open', { detail: { type: targetType } }));
      });
    });
  }, [closeModal]);

  useEffect(() => {
    let cleanup: (() => void) | null = null;

    const applyTheme = (newTheme: string) => {
      const visualTheme = document.documentElement.getAttribute('data-visual-theme');
      if (visualTheme === 'day' || visualTheme === 'night') {
        document.documentElement.setAttribute(
          'data-theme',
          visualTheme === 'night' ? 'dark' : 'light',
        );
        document.documentElement.style.colorScheme =
          visualTheme === 'night' ? 'dark' : 'light';
        return;
      }

      if (newTheme === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
      } else {
        document.documentElement.setAttribute('data-theme', newTheme);
      }
    };

    const applyUiScale = async (rawScale?: number) => {
      const normalizedScale = normalizeUiScale(rawScale);
      reflectUiScale(normalizedScale);
      try {
        await getCurrentWebview().setZoom(normalizedScale);
      } catch (error) {
        console.error('Failed to apply UI scale:', error);
      }
    };

    const watchSystemTheme = () => {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = () => applyTheme('system');

      if (mediaQuery.addEventListener) {
        mediaQuery.addEventListener('change', handleChange);
      } else {
        mediaQuery.addListener(handleChange);
      }

      return () => {
        if (mediaQuery.removeEventListener) {
          mediaQuery.removeEventListener('change', handleChange);
        } else {
          mediaQuery.removeListener(handleChange);
        }
      };
    };

    const initTheme = async () => {
      try {
        const config = await invoke<GeneralConfigTheme>('get_general_config');
        applyTheme(config.theme);
        void applyUiScale(config.ui_scale);
        if (config.theme === 'system') {
          cleanup = watchSystemTheme();
        }
      } catch (error) {
        console.error('Failed to load theme config:', error);
      }
    };

    initTheme();

    return () => {
      if (cleanup) {
        cleanup();
      }
    };
  }, []);

  useEffect(() => {
    const syncWakeupStateOnStartup = async () => {
      let officialLsVersionMode = loadWakeupOfficialLsVersionMode();
      try {
        // 一次性迁移：升级到该版本后先将唤醒总开关置为关闭，用户仍可手动再开启
        if (localStorage.getItem(WAKEUP_FORCE_DISABLE_MIGRATION_KEY) !== '1') {
          localStorage.setItem(WAKEUP_ENABLED_KEY, 'false');
          localStorage.setItem(WAKEUP_FORCE_DISABLE_MIGRATION_KEY, '1');
        }
        const enabled = localStorage.getItem(WAKEUP_ENABLED_KEY) === 'true';
        const tasksRaw = localStorage.getItem(TASKS_STORAGE_KEY);
        const tasks = tasksRaw ? JSON.parse(tasksRaw) : [];
        officialLsVersionMode = loadWakeupOfficialLsVersionMode();
        await invoke('wakeup_sync_state', {
          enabled,
          tasks,
          officialLsVersionMode,
          runStartupTasks: true,
        });
      } catch (error) {
        console.error('唤醒任务状态同步失败:', error);
      }
    };
    void syncWakeupStateOnStartup();
  }, []);

  useEffect(() => {
    const AUTO_BACKUP_STARTUP_DELAY_MS = 5 * 60 * 1000;
    const AUTO_BACKUP_POLL_INTERVAL_MS = 60 * 60 * 1000;
    let startupTimerId: number | undefined;
    let intervalId: number | undefined;
    let inFlight = false;

    const checkAutoBackup = async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        await runAutoBackupCycle();
      } catch (error) {
        console.warn('[AutoBackup] 定期备份执行失败:', error);
      } finally {
        inFlight = false;
      }
    };

    startupTimerId = window.setTimeout(() => {
      void checkAutoBackup();
      intervalId = window.setInterval(() => {
        void checkAutoBackup();
      }, AUTO_BACKUP_POLL_INTERVAL_MS);
    }, AUTO_BACKUP_STARTUP_DELAY_MS);

    return () => {
      if (startupTimerId !== undefined) {
        window.clearTimeout(startupTimerId);
      }
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    listen<string>('settings:language_changed', (event) => {
      const nextLanguage = normalizeLanguage(String(event.payload || ''));
      if (!nextLanguage || nextLanguage === getCurrentLanguage()) {
        return;
      }
      void changeLanguage(nextLanguage);
      window.dispatchEvent(new CustomEvent('general-language-updated', { detail: { language: nextLanguage } }));
    }).then((fn) => { unlisten = fn; });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    listen<QuotaAlertPayload>('quota:alert', (event) => {
      const payload = event.payload;
      if (!payload || !payload.current_account_id) {
        return;
      }

      const platform = normalizeQuotaAlertPlatform(payload.platform);
      const platformLabel = getQuotaAlertPlatformLabel(platform, t);
      const hasRecommendation = Boolean(payload.recommended_account_id && payload.recommended_email);
      const modelsText = payload.low_models.length > 0
        ? payload.low_models.join(', ')
        : t('quotaAlert.modal.unknownModel', '未知模型');

      showModal({
        title: t('quotaAlert.modal.title', '配额预警'),
        description: t(
          'quotaAlert.modal.desc',
          '当前账号配额已达到预警阈值，请尽快处理。'
        ),
        width: 'md',
        content: (
          <div className="quota-alert-modal-content">
            <div className="quota-alert-modal-row">
              <span>{t('quotaAlert.modal.platform', '平台')}</span>
              <strong>{platformLabel}</strong>
            </div>
            <div className="quota-alert-modal-row">
              <span>{t('quotaAlert.modal.account', '当前账号')}</span>
              <strong>{payload.current_email}</strong>
            </div>
            <div className="quota-alert-modal-row">
              <span>{t('quotaAlert.modal.threshold', '预警阈值')}</span>
              <strong>{payload.threshold_display || `${payload.threshold}%`}</strong>
            </div>
            <div className="quota-alert-modal-row">
              <span>{t('quotaAlert.modal.lowest', '当前最低')}</span>
              <strong>{payload.lowest_percentage}%</strong>
            </div>
            <div className="quota-alert-modal-row quota-alert-modal-row--stack">
              <span>{t('quotaAlert.modal.models', '触发模型')}</span>
              <strong>{modelsText}</strong>
            </div>
            <div className="quota-alert-modal-row">
              <span>{t('quotaAlert.modal.recommended', '建议切换')}</span>
              <strong>
                {payload.recommended_email || t('quotaAlert.modal.noRecommendation', '暂无可切换账号')}
              </strong>
            </div>
          </div>
        ),
        actions: [
          {
            id: 'quota-alert-later',
            label: t('quotaAlert.modal.later', '稍后处理'),
            variant: 'secondary',
          },
          {
            id: 'quota-alert-open-settings',
            label: t('quotaAlert.modal.openSettings', '调整预警设置'),
            variant: 'secondary',
            autoClose: false,
            onClick: () => {
              openQuickSettingsForPlatform(platform);
            },
          },
          ...(hasRecommendation
            ? [{
                id: 'quota-alert-switch',
                label: t('quotaAlert.modal.switchNow', '快捷切号到 {{email}}', {
                  email: payload.recommended_email as string,
                }),
                variant: 'primary' as const,
                autoClose: false,
                onClick: async () => {
                  try {
                    const targetAccountId = payload.recommended_account_id as string;
                    if (platform === 'codex') {
                      await useCodexAccountStore.getState().switchAccount(targetAccountId);
                      setPage('codex');
                    } else if (platform === 'claude') {
                      await useClaudeAccountStore.getState().switchAccount(targetAccountId);
                      setPage('claude');
                    } else if (platform === 'github_copilot') {
                      await useGitHubCopilotAccountStore.getState().switchAccount(targetAccountId);
                      setPage('github-copilot');
                    } else if (platform === 'windsurf') {
                      await useWindsurfAccountStore.getState().switchAccount(targetAccountId);
                      setPage('windsurf');
                    } else if (platform === 'kiro') {
                      await useKiroAccountStore.getState().switchAccount(targetAccountId);
                      setPage('kiro');
                    } else if (platform === 'cursor') {
                      await useCursorAccountStore.getState().switchAccount(targetAccountId);
                      setPage('cursor');
                    } else if (platform === 'gemini') {
                      await useGeminiAccountStore.getState().switchAccount(targetAccountId);
                      setPage('gemini');
                    } else if (platform === 'codebuddy') {
                      await useCodebuddyAccountStore.getState().switchAccount(targetAccountId);
                      setPage('codebuddy');
                    } else if (platform === 'codebuddy_cn') {
                      await useCodebuddyCnAccountStore.getState().switchAccount(targetAccountId);
                      setPage('codebuddy-cn');
                    } else if (platform === 'qoder') {
                      await useQoderAccountStore.getState().switchAccount(targetAccountId);
                      setPage('qoder');
                    } else if (platform === 'trae') {
                      await useTraeAccountStore.getState().switchAccount(targetAccountId);
                      setPage('trae');
                    } else if (platform === 'workbuddy') {
                      await useWorkbuddyAccountStore.getState().switchAccount(targetAccountId);
                      setPage('workbuddy');
                    } else if (platform === 'zed') {
                      await useZedAccountStore.getState().switchAccount(targetAccountId);
                      setPage('zed');
                    } else {
                      await useAccountStore.getState().switchAccount(targetAccountId);
                      setPage('overview');
                    }
                    closeModal();
                  } catch (error) {
                    showModal({
                      title: t('quotaAlert.modal.switchFailedTitle', '切号失败'),
                      description: t('quotaAlert.modal.switchFailedBody', '快捷切号失败：{{error}}', {
                        error: String(error),
                      }),
                      width: 'sm',
                      actions: [
                        {
                          id: 'quota-alert-switch-failed-ok',
                          label: t('common.confirm', '确定'),
                          variant: 'primary',
                        },
                      ],
                    });
                  }
                },
              }]
            : []),
        ],
      });
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [closeModal, openQuickSettingsForPlatform, showModal, t]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    const handleWakeupResult = (payload: WakeupTaskResultPayload) => {
      if (!payload || typeof payload.taskId !== 'string') return;

      // 更新任务的最后运行时间
      const tasksRaw = localStorage.getItem(TASKS_STORAGE_KEY);
      if (tasksRaw) {
        try {
          const tasks = JSON.parse(tasksRaw) as Array<{ id: string; lastRunAt?: number }>;
          const nextTasks = tasks.map((task) =>
            task.id === payload.taskId ? { ...task, lastRunAt: payload.lastRunAt } : task
          );
          localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(nextTasks));
        } catch (error) {
          console.error('更新唤醒任务时间失败:', error);
        }
      }

      // 历史记录已由后端写入文件，这里只需通知前端刷新
      window.dispatchEvent(new CustomEvent('wakeup-task-result', { detail: payload }));
      window.dispatchEvent(new Event('wakeup-tasks-updated'));
    };

    listen<WakeupTaskResultPayload>('wakeup://task-result', (event) => {
      handleWakeupResult(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    const refreshTasks = [
      {
        command: 'refresh_current_quota',
        errorMessage: 'Failed to refresh Antigravity IDE quotas:',
      },
      {
        command: 'refresh_current_codex_quota',
        errorMessage: 'Failed to refresh Codex quotas:',
      },
      {
        command: 'refresh_all_claude_quotas',
        errorMessage: 'Failed to refresh Claude quotas:',
      },
      {
        command: 'refresh_all_github_copilot_tokens',
        errorMessage: 'Failed to refresh GitHub Copilot quotas:',
      },
      {
        command: 'refresh_all_windsurf_tokens',
        errorMessage: 'Failed to refresh Windsurf quotas:',
      },
      {
        command: 'refresh_all_kiro_tokens',
        errorMessage: 'Failed to refresh Kiro quotas:',
      },
      {
        command: 'refresh_all_cursor_tokens',
        errorMessage: 'Failed to refresh Cursor:',
      },
      {
        command: 'refresh_all_gemini_tokens',
        errorMessage: 'Failed to refresh Gemini:',
      },
      {
        command: 'refresh_all_codebuddy_tokens',
        errorMessage: 'Failed to refresh CodeBuddy:',
      },
      {
        command: 'refresh_all_codebuddy_cn_tokens',
        errorMessage: 'Failed to refresh CodeBuddy CN:',
      },
      {
        command: 'refresh_all_qoder_tokens',
        errorMessage: 'Failed to refresh Qoder:',
      },
      {
        command: 'refresh_all_trae_tokens',
        errorMessage: 'Failed to refresh Trae:',
      },
      {
        command: 'refresh_all_zed_tokens',
        errorMessage: 'Failed to refresh Zed:',
      },
    ] as const;

    listen('tray:refresh_quota', async () => {
      if (trayRefreshInFlightRef.current) {
        return;
      }
      trayRefreshInFlightRef.current = true;

      try {
        await Promise.all(
          refreshTasks.map(({ command, errorMessage }) =>
            invoke(command).catch((error) => {
              console.error(errorMessage, error);
            }),
          ),
        );
      } finally {
        trayRefreshInFlightRef.current = false;
      }
    }).then((fn) => { unlisten = fn; });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    const handlePayload = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const detail = payload as AppPathMissingDetail;
      if (
        detail.app !== 'antigravity' &&
        detail.app !== 'codex' &&
        detail.app !== 'claude' &&
        detail.app !== 'vscode' &&
        detail.app !== 'windsurf' &&
        detail.app !== 'kiro' &&
        detail.app !== 'cursor' &&
        detail.app !== 'codebuddy' &&
        detail.app !== 'codebuddy_cn' &&
        detail.app !== 'qoder' &&
        !isTraePlatformApp(detail.app) &&
        detail.app !== 'workbuddy' &&
        detail.app !== 'zed'
      ) {
        return;
      }
      setAppPathMissing(detail);
    };

    listen('app:path_missing', (event) => {
      handlePayload(event.payload);
    }).then((fn) => { unlisten = fn; });

    const handleWindowEvent = (event: Event) => {
      const custom = event as CustomEvent<AppPathMissingDetail>;
      handlePayload(custom.detail);
    };
    window.addEventListener('app-path-missing', handleWindowEvent as EventListener);

    return () => {
      if (unlisten) {
        unlisten();
      }
      window.removeEventListener('app-path-missing', handleWindowEvent as EventListener);
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!appPathMissing) {
      setAppPathDraft('');
      setAppPathScanRootsDraft('');
      setAppLaunchCandidates([]);
      setAppPathDetecting(false);
      setAppPathActionError('');
      setAppPathCodexLaunchOnSwitch(true);
      setAppPathCodexLaunchSetting(false);
      return () => {
        active = false;
      };
    }
    setAppPathActionError('');
    setAppLaunchCandidates([]);
    (async () => {
      try {
        const config = await invoke<GeneralConfig>('get_general_config');
        const currentPath =
          appPathMissing.app === 'codex'
            ? config.codex_app_path
            : appPathMissing.app === 'claude'
              ? config.claude_app_path
            : appPathMissing.app === 'vscode'
              ? config.vscode_app_path
              : appPathMissing.app === 'windsurf'
                ? config.windsurf_app_path
              : appPathMissing.app === 'kiro'
                ? config.kiro_app_path
              : appPathMissing.app === 'cursor'
                ? config.cursor_app_path
              : appPathMissing.app === 'codebuddy'
                ? config.codebuddy_app_path
              : appPathMissing.app === 'codebuddy_cn'
                ? config.codebuddy_cn_app_path
              : appPathMissing.app === 'qoder'
                ? config.qoder_app_path
              : isTraePlatformApp(appPathMissing.app)
                ? getTraeAppPath(config, appPathMissing.app)
              : appPathMissing.app === 'workbuddy'
                ? config.workbuddy_app_path
              : appPathMissing.app === 'zed'
                ? config.zed_app_path
              : config.antigravity_app_path;
        if (active) {
          const normalizedPath = currentPath || '';
          const shouldClearClaudeDefaultTarget =
            appPathMissing.app === 'claude' &&
            appPathMissing.retry?.kind === 'instance' &&
            isClaudeWindowsAppLaunchTarget(normalizedPath);
          setAppPathDraft(shouldClearClaudeDefaultTarget ? '' : normalizedPath);
          setAppPathScanRootsDraft(
            appPathMissing.app === 'claude'
              ? config.claude_app_scan_roots || ''
              : isTraePlatformApp(appPathMissing.app)
                ? getTraeAppScanRoots(config, appPathMissing.app) || ''
                : '',
          );
          setAppPathCodexLaunchOnSwitch(config.codex_launch_on_switch ?? true);
        }
      } catch (error) {
        console.error('Failed to load app path config:', error);
      }
    })();
    return () => {
      active = false;
    };
  }, [appPathMissing]);

  const handlePickMissingAppPath = async () => {
    if (appPathSetting) return;
    try {
      const selected = await open({
        multiple: false,
        directory: false,
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (path) {
        setAppPathActionError('');
        setAppPathDraft(path);
        setAppLaunchCandidates([]);
      }
    } catch (error) {
      console.error('选择应用路径失败:', error);
    }
  };

  const handlePickMissingAppScanRoot = async () => {
    if (appPathSetting || appPathDetecting) return;
    try {
      const selected = await open({
        multiple: false,
        directory: true,
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (path) {
        setAppPathActionError('');
        setAppPathScanRootsDraft(path);
        setAppLaunchCandidates([]);
      }
    } catch (error) {
      console.error('选择 Claude 扫描范围失败:', error);
    }
  };

  const handleClearMissingAppScanRoot = () => {
    if (appPathSetting || appPathDetecting) return;
    setAppPathActionError('');
    setAppPathScanRootsDraft('');
    setAppLaunchCandidates([]);
  };

  const handleSaveMissingAppPath = async () => {
    if (!appPathMissing || appPathSetting || appPathDetecting) return;
    const path = appPathDraft.trim();
    if (!path) return;
    if (
      appPathMissing.app === 'claude' &&
      appPathMissing.retry?.kind === 'instance' &&
      isClaudeWindowsAppLaunchTarget(path)
    ) {
      setAppPathActionError(
        t(
          'appPath.missing.claudeMultiInstanceRequiresExe',
          'Claude 应用多开需要真实 Claude.exe 路径；Microsoft Store 启动目标仅适用于默认桌面端。',
        ),
      );
      return;
    }
    setAppPathSetting(true);
    setAppPathActionError('');
    try {
      const app = appPathMissing.app;
      const retry = appPathMissing.retry;
      const antigravityInstanceStartCommand =
        app === 'antigravity' && retry?.runtimeTarget !== 'antigravity_ide'
          ? 'antigravity_legacy_start_instance'
          : 'start_instance';
      await invoke('set_app_path', { app, path });
      if (app === 'claude') {
        await invoke('set_claude_app_scan_roots', {
          scanRoots: appPathScanRootsDraft.trim(),
        });
      } else if (isTraePlatformApp(app)) {
        await invoke('set_trae_app_scan_roots', {
          app,
          scanRoots: appPathScanRootsDraft.trim(),
        });
      }
      if (retry?.kind === 'switchAccount' && retry.accountId && app === 'zed') {
        await useZedAccountStore.getState().switchAccount(retry.accountId);
        setPage('zed');
      } else if (retry?.kind === 'switchAccount' && retry.accountId && app === 'claude') {
        await useClaudeAccountStore.getState().switchAccount(retry.accountId);
        await useClaudeAccountStore.getState().fetchCurrentAccountId();
        setPage('claude');
      } else if (retry?.kind === 'switchAccount' && retry.accountId) {
        await invoke('switch_account', {
          accountId: retry.accountId,
          runtimeTarget: retry.runtimeTarget,
        });
        await Promise.allSettled([
          useAccountStore.getState().fetchAccounts(),
          useAccountStore.getState().fetchCurrentAccount(),
        ]);
      } else if (retry?.kind === 'instance' && retry.instanceId) {
        if (app === 'codex') {
          await invoke('codex_start_instance', { instanceId: retry.instanceId });
        } else if (app === 'claude') {
          await invoke('claude_start_instance', { instanceId: retry.instanceId });
        } else if (app === 'vscode') {
          await invoke('github_copilot_start_instance', { instanceId: retry.instanceId });
        } else if (app === 'windsurf') {
          await invoke('windsurf_start_instance', { instanceId: retry.instanceId });
        } else if (app === 'kiro') {
          await invoke('kiro_start_instance', { instanceId: retry.instanceId });
        } else if (app === 'cursor') {
          await invoke('cursor_start_instance', { instanceId: retry.instanceId });
        } else if (app === 'codebuddy') {
          await invoke('codebuddy_start_instance', { instanceId: retry.instanceId });
        } else if (app === 'codebuddy_cn') {
          await invoke('codebuddy_cn_start_instance', { instanceId: retry.instanceId });
        } else if (app === 'qoder') {
          await invoke('qoder_start_instance', { instanceId: retry.instanceId });
        } else if (isTraePlatformApp(app)) {
          await invoke('trae_start_instance', { platformId: app, instanceId: retry.instanceId });
        } else if (app === 'workbuddy') {
          await invoke('workbuddy_start_instance', { instanceId: retry.instanceId });
        } else if (app === 'zed') {
          await invoke('zed_start_default_session');
        } else {
          await invoke(antigravityInstanceStartCommand, { instanceId: retry.instanceId });
        }
      } else {
        if (app === 'codex') {
          await invoke('codex_start_instance', { instanceId: '__default__' });
        } else if (app === 'claude') {
          await invoke('claude_start_instance', { instanceId: '__default__' });
        } else if (app === 'vscode') {
          await invoke('github_copilot_start_instance', { instanceId: '__default__' });
        } else if (app === 'windsurf') {
          await invoke('windsurf_start_instance', { instanceId: '__default__' });
        } else if (app === 'kiro') {
          await invoke('kiro_start_instance', { instanceId: '__default__' });
        } else if (app === 'cursor') {
          await invoke('cursor_start_instance', { instanceId: '__default__' });
        } else if (app === 'codebuddy') {
          await invoke('codebuddy_start_instance', { instanceId: '__default__' });
        } else if (app === 'codebuddy_cn') {
          await invoke('codebuddy_cn_start_instance', { instanceId: '__default__' });
        } else if (app === 'qoder') {
          await invoke('qoder_start_instance', { instanceId: '__default__' });
        } else if (isTraePlatformApp(app)) {
          await invoke('trae_start_instance', { platformId: app, instanceId: '__default__' });
        } else if (app === 'workbuddy') {
          await invoke('workbuddy_start_instance', { instanceId: '__default__' });
        } else if (app === 'zed') {
          await invoke('zed_start_default_session');
        } else {
          await invoke(antigravityInstanceStartCommand, { instanceId: '__default__' });
        }
      }
      setAppPathMissing(null);
      setAppPathSetting(false);
    } catch (error) {
      console.error('设置应用路径失败:', error);
      setAppPathActionError(String(error));
      setAppPathSetting(false);
    }
  };

  const handleResetMissingAppPath = async () => {
    if (!appPathMissing || appPathSetting || appPathDetecting) return;
    const scanApp =
      appPathMissing.app === 'antigravity' && appPathMissing.retry?.runtimeTarget !== 'antigravity_ide'
        ? 'antigravity_legacy'
        : appPathMissing.app === 'antigravity' && appPathMissing.retry?.runtimeTarget === 'antigravity_ide'
          ? 'antigravity_ide'
          : appPathMissing.app;

    if (isWindowsPlatform()) {
      setAppPathDetecting(true);
      setAppPathActionError('');
      try {
        const candidates = await invoke<AppLaunchCandidate[]>('scan_app_launch_targets', {
          app: scanApp,
          scanRoots: appPathScanRootsDraft.trim() || null,
        });
        setAppLaunchCandidates(candidates);
        if (appPathMissing.app === 'claude' && appPathMissing.retry?.kind === 'instance') {
          const exeCandidate = candidates.find((candidate) => candidate.supports_multi_instance);
          if (exeCandidate) {
            setAppPathDraft(exeCandidate.target);
          } else if (candidates.length > 0) {
            setAppPathActionError(
              t(
                'appPath.missing.claudeMultiInstanceRequiresExe',
                'Claude 应用多开需要真实 Claude.exe 路径；Microsoft Store 启动目标仅适用于默认桌面端。',
              ),
            );
          }
        } else if (candidates.length > 0) {
          setAppPathDraft(candidates[0].target);
        }
        if (candidates.length === 0 && appPathMissing.app !== 'claude') {
          setAppPathActionError(
            t('appPath.missing.scanEmptyGeneric', '未扫描到 {{app}}，请手动选择路径或调整扫描范围。', {
              app: appPathMissingAppName,
            }),
          );
        } else if (candidates.length === 0) {
          setAppPathActionError(
            t('appPath.missing.claudeScanEmpty', '未扫描到 Claude Desktop，请手动选择 Claude.exe 或调整扫描范围。'),
          );
        }
      } catch (error) {
        console.error('扫描 Claude Desktop 启动目标失败:', error);
        setAppPathActionError(String(error));
      } finally {
        setAppPathDetecting(false);
      }
      return;
    }
    setAppPathDetecting(true);
    try {
      const detected = await invoke<string | null>('detect_app_path', {
        app: scanApp,
        force: true,
      });
      setAppPathActionError('');
      setAppPathDraft((detected || '').trim());
    } catch (error) {
      console.error('自动探测应用路径失败:', error);
    } finally {
      setAppPathDetecting(false);
    }
  };

  const handleToggleCodexLaunchInMissingPath = async (enabled: boolean) => {
    if (!appPathMissing || appPathMissing.app !== 'codex') return;
    if (appPathSetting || appPathDetecting || appPathCodexLaunchSetting) return;
    setAppPathCodexLaunchSetting(true);
    setAppPathActionError('');
    try {
      await invoke('set_codex_launch_on_switch', { enabled });
      setAppPathCodexLaunchOnSwitch(enabled);
      if (!enabled) {
        setAppPathMissing(null);
      }
    } catch (error) {
      console.error('更新 Codex 自动启动配置失败:', error);
      setAppPathActionError(String(error));
    } finally {
      setAppPathCodexLaunchSetting(false);
    }
  };

  const handleSelectAppLaunchCandidate = (candidate: AppLaunchCandidate) => {
    if (
      appPathMissing?.app === 'claude' &&
      appPathMissing.retry?.kind === 'instance' &&
      !candidate.supports_multi_instance
    ) {
      return;
    }
    setAppPathActionError('');
    setAppPathDraft(candidate.target);
  };

  // 监听窗口关闭请求事件
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    listen('window:close_requested', () => {
      setShowCloseDialog(true);
    }).then((fn) => { unlisten = fn; });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

        listen<string>('tray:navigate', (event) => {
          const target = String(event.payload || '');
          switch (target) {
            case 'overview':
            case 'codex':
            case 'codex-api-service':
            case 'multi-model-api-service':
            case 'claude-web-api':
            case 'claude':
            case 'claude-cli':
            case 'github-copilot':
            case 'windsurf':
            case 'kiro':
            case 'cursor':
            case 'gemini':
            case 'codebuddy':
            case 'codebuddy-cn':
            case 'qoder':
            case 'trae':
            case 'trae-solo':
            case 'trae-cn':
            case 'trae-solo-cn':
            case 'workbuddy':
            case 'zed':
            case 'manual':
            case 'settings':
              setPage(target as Page);
              break;
            default:
              break;
          }
        }).then((fn) => { unlisten = fn; });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen('external:provider-import', (event) => {
      console.info('[ExternalImport][App] 收到 Tauri 事件 external:provider-import');
      void handleExternalProviderImportRawPayload(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleExternalProviderImportRawPayload]);

  useEffect(() => {
    let canceled = false;
    void invoke<unknown>('external_import_take_pending')
      .then((payload) => {
        if (canceled) return;
        if (!payload) {
          console.info('[ExternalImport][App] 启动时无待处理导入 payload');
          return;
        }
        console.info('[ExternalImport][App] 启动时读取到待处理导入 payload');
        void handleExternalProviderImportRawPayload(payload);
      })
      .catch((error) => {
        console.warn('[ExternalImport] 读取待处理导入请求失败:', error);
      });
    return () => {
      canceled = true;
    };
  }, [handleExternalProviderImportRawPayload]);

  // 窗口拖拽处理
  const handleDragStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    void getCurrentWindow().startDragging().catch((error) => {
      console.warn('[Window] startDragging failed:', error);
    });
  };

  useEffect(() => {
    const handleRequestNavigate = (e: Event) => {
      const custom = e as CustomEvent<Page>;
      if (custom.detail) {
        setPage(custom.detail);
      }
    };
    window.addEventListener('app-request-navigate', handleRequestNavigate as EventListener);
    return () => {
      window.removeEventListener('app-request-navigate', handleRequestNavigate as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleOpenPlatformLayout = (e: Event) => {
      const custom = e as CustomEvent<{ groupId?: string | null }>;
      const groupId =
        custom.detail && typeof custom.detail.groupId === 'string' && custom.detail.groupId.trim()
          ? custom.detail.groupId.trim()
          : null;
      setPlatformLayoutRequestedGroupId(groupId);
      setShowPlatformLayoutModal(true);
    };

    window.addEventListener('app-open-platform-layout', handleOpenPlatformLayout as EventListener);
    return () => {
      window.removeEventListener('app-open-platform-layout', handleOpenPlatformLayout as EventListener);
    };
  }, []);
  const suspenseFallback = (
    <div className="loading-state">
      {t('common.loading', '加载中...')}
    </div>
  );

  const appPathMissingRuntimeTarget = appPathMissing?.retry?.runtimeTarget;
  const appPathMissingAppName = appPathMissing
    ? appPathMissing.app === 'codex'
      ? 'Codex'
      : appPathMissing.app === 'claude'
        ? 'Claude Desktop'
      : appPathMissing.app === 'vscode'
        ? 'VS Code'
        : appPathMissing.app === 'windsurf'
          ? 'Windsurf'
          : appPathMissing.app === 'kiro'
            ? 'Kiro'
            : appPathMissing.app === 'cursor'
            ? 'Cursor'
            : appPathMissing.app === 'codebuddy'
              ? 'CodeBuddy'
              : appPathMissing.app === 'codebuddy_cn'
                ? 'CodeBuddy CN'
              : appPathMissing.app === 'qoder'
                ? 'Qoder'
              : isTraePlatformApp(appPathMissing.app)
                ? 'Trae'
              : appPathMissing.app === 'workbuddy'
                ? 'WorkBuddy'
              : appPathMissing.app === 'antigravity' && appPathMissingRuntimeTarget === 'antigravity_ide'
                ? 'Antigravity IDE'
                : 'Antigravity'
    : '';

  const appPathMissingPathLabel = appPathMissing
    ? appPathMissing.app === 'codex'
      ? t('quickSettings.codex.appPath', '启动路径')
      : appPathMissing.app === 'claude'
        ? t('quickSettings.claude.appPath', 'Claude Desktop 启动目标')
      : appPathMissing.app === 'vscode'
        ? t('quickSettings.githubCopilot.appPath', 'VS Code 路径')
        : appPathMissing.app === 'windsurf'
          ? t('quickSettings.windsurf.appPath', 'Windsurf 路径')
          : appPathMissing.app === 'kiro'
            ? t('quickSettings.kiro.appPath', 'Kiro 路径')
            : appPathMissing.app === 'cursor'
            ? t('quickSettings.cursor.appPath', 'Cursor 路径')
            : appPathMissing.app === 'codebuddy'
              ? t('quickSettings.codebuddy.appPath', 'CodeBuddy 路径')
              : appPathMissing.app === 'codebuddy_cn'
                ? t('quickSettings.codebuddyCn.appPath', 'CodeBuddy CN 路径')
              : appPathMissing.app === 'qoder'
                ? t('quickSettings.qoder.appPath', 'Qoder 路径')
              : isTraePlatformApp(appPathMissing.app)
                ? t('quickSettings.trae.appPath', 'Trae 路径')
              : t('quickSettings.antigravity.appPath', '启动路径')
    : t('quickSettings.antigravity.appPath', '启动路径');
  const appPathMissingBusy = appPathSetting || appPathDetecting || appPathCodexLaunchSetting;
  const claudeMultiInstanceNeedsExe =
    appPathMissing?.app === 'claude' && appPathMissing.retry?.kind === 'instance';
  return (
    <StartupPerformanceProvider ready={startupReady}>
      <div
        className={`app-container${isWindowsPlatform() ? ' app-container-windows' : ''}${isMacOSPlatform() ? ' app-container-macos' : ''}${sideNavLayoutMode === 'classic' ? ' app-container-side-nav-classic' : ''}${sideNavLayoutMode === 'classic' && sideNavClassicCollapsed ? ' app-container-side-nav-classic-collapsed' : ''}`}
      >
      <AmbientInteractionLayer enabled={startupReady} />
      <PetFishCursorLayer enabled={startupReady} />
      <GlobalModal />

      {/* 关闭确认对话框 */}
      {showCloseDialog && (
        <Suspense fallback={null}>
          <CloseConfirmDialog onClose={() => setShowCloseDialog(false)} />
        </Suspense>
      )}

      {hasBreakoutSession && (
        <Suspense fallback={null}>
          <BreakoutModal
            open={showBreakout}
            onMinimize={handleBreakoutMinimize}
            onTerminate={handleBreakoutTerminate}
          />
        </Suspense>
      )}

      {appPathMissing && (
        <div className="qs-overlay" style={{ zIndex: 10100 }}>
          <div className="qs-modal app-path-missing-modal" onClick={(e) => e.stopPropagation()}>
            <div className="qs-header">
              <span className="qs-title">{t('appPath.missing.title', '未找到应用程序路径')}</span>
              <button
                className="qs-close"
                onClick={() => setAppPathMissing(null)}
                aria-label={t('common.close', '关闭')}
                disabled={appPathMissingBusy}
              >
                <X size={16} />
              </button>
            </div>

            <div className="qs-body">
              <div className="qs-section">
                <p className="app-path-missing-desc">
                  {t('appPath.missing.desc', '未找到 {{app}} 应用程序路径，请立即设置后继续启动。', {
                    app: appPathMissingAppName,
                  })}
                </p>
                {claudeMultiInstanceNeedsExe ? (
                  <p className="app-path-missing-hint">
                    {t(
                      'appPath.missing.claudeMultiInstanceRequiresExe',
                      'Claude 应用多开需要真实 Claude.exe 路径；Microsoft Store 启动目标仅适用于默认桌面端。',
                    )}
                  </p>
                ) : null}
              </div>

              {appPathMissing.app === 'codex' ? (
                <div className="qs-section">
                  <div className="qs-row">
                    <div className="qs-row-label">
                      {t('settings.general.codexLaunchOnSwitch', '切换 Codex 时自动启动 Codex App')}
                    </div>
                    <label className="qs-switch">
                      <input
                        type="checkbox"
                        checked={appPathCodexLaunchOnSwitch}
                        disabled={appPathMissingBusy}
                        onChange={(e) => handleToggleCodexLaunchInMissingPath(e.target.checked)}
                      />
                      <span className="qs-switch-slider" />
                    </label>
                  </div>
                  <p className="app-path-missing-hint">
                    {t(
                      'appPath.missing.codexLaunchHint',
                      '关闭后仅执行切号与登录覆盖，不再尝试启动 Codex App，也不会再次要求设置启动路径。'
                    )}
                  </p>
                </div>
              ) : null}

              <div className="qs-section">
                <div className="qs-section-header">
                  <FolderOpen size={15} />
                  <span>{appPathMissingPathLabel}</span>
                </div>
                {isWindowsPlatform() ? (
                  <div className="app-path-missing-scan-roots">
                    <label>{t('appPath.missing.scanRoots', '扫描范围')}</label>
                    <div className="app-path-missing-scan-root-row">
                      <input
                        type="text"
                        className="qs-path-input app-path-missing-scan-roots-input"
                        value={appPathScanRootsDraft}
                        placeholder={t(
                          'appPath.missing.scanRootsPlaceholder',
                          '可选，选择一个目录或盘符；留空时按盘符扫描 WindowsApps 并补充开始菜单应用。',
                        )}
                        readOnly
                        disabled={appPathMissingBusy}
                      />
                      <div className="qs-path-actions">
                        <button
                          className="qs-btn"
                          onClick={handlePickMissingAppScanRoot}
                          disabled={appPathMissingBusy}
                        >
                          {t('settings.general.codexPathSelect', '选择')}
                        </button>
                        <button
                          className="qs-btn"
                          onClick={handleClearMissingAppScanRoot}
                          disabled={appPathMissingBusy || !appPathScanRootsDraft.trim()}
                        >
                          {t('common.clear', '清除')}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="qs-path-control">
                  <input
                    type="text"
                    className="qs-path-input"
                    value={appPathDraft}
                    placeholder={
                      appPathMissing.app === 'claude'
                        ? t(
                            'appPath.missing.claudeTargetPlaceholder',
                            'Claude.exe 路径或 shell:AppsFolder\\...',
                          )
                        : t('settings.general.codexAppPathPlaceholder', '默认路径')
                    }
                    onChange={(e) => setAppPathDraft(e.target.value)}
                    disabled={appPathMissingBusy}
                  />
                  <div className="qs-path-actions">
                    <button
                      className="qs-btn"
                      onClick={handlePickMissingAppPath}
                      disabled={appPathMissingBusy}
                    >
                      {t('settings.general.codexPathSelect', '选择')}
                    </button>
                    <button
                      className="qs-btn"
                      onClick={handleResetMissingAppPath}
                      disabled={appPathMissingBusy}
                      title={
                        appPathDetecting
                          ? t('common.loading', '加载中...')
                          : isWindowsPlatform()
                            ? t('appPath.missing.scanApps', '鎵弿搴旂敤')
                            : (
                            appPathMissing.app === 'vscode'
                              ? t('settings.general.vscodePathReset', '重置默认')
                              : appPathMissing.app === 'windsurf'
                                ? t('settings.general.windsurfPathReset', '重置默认')
                                : appPathMissing.app === 'kiro'
                                  ? t('settings.general.kiroPathReset', '重置默认')
                                  : appPathMissing.app === 'cursor'
                                  ? t('settings.general.cursorPathReset', '重置默认')
                                    : appPathMissing.app === 'codebuddy'
                                      ? t('settings.general.codebuddyPathReset', '重置默认')
                                    : appPathMissing.app === 'codebuddy_cn'
                                      ? t('settings.general.codebuddyPathReset', '重置默认')
                                    : appPathMissing.app === 'qoder'
                                      ? t('settings.general.qoderPathReset', '重置默认')
                                    : isTraePlatformApp(appPathMissing.app)
                                      ? t('settings.general.traePathReset', '重置默认')
                                    : t('settings.general.codexPathReset', '重置默认')
                          )
                      }
                    >
                      {isWindowsPlatform() ? (
                        appPathDetecting
                          ? t('common.loading', '加载中...')
                          : t('appPath.missing.scanApps', '扫描应用')
                      ) : (
                        <RefreshCw size={12} className={appPathDetecting ? 'spin' : undefined} />
                      )}
                    </button>
                  </div>
                </div>
                {isWindowsPlatform() ? (
                  <>
                    {appLaunchCandidates.length > 0 ? (
                      <div className="app-path-candidate-list">
                        {appLaunchCandidates.map((candidate) => (
                          <button
                            key={`${candidate.target_type}:${candidate.target}`}
                            type="button"
                            className={`app-path-candidate-item${
                              appPathDraft.trim() === candidate.target ? ' selected' : ''
                            }`}
                            onClick={() => handleSelectAppLaunchCandidate(candidate)}
                            disabled={
                              appPathMissingBusy ||
                              (claudeMultiInstanceNeedsExe && !candidate.supports_multi_instance)
                            }
                          >
                            <div className="app-path-candidate-main">
                              <span>{candidate.label || appPathMissingAppName}</span>
                              <span className="app-path-candidate-badge">
                                {candidate.target_type === 'windows_app'
                                  ? t('appPath.missing.windowsApp', 'Microsoft Store')
                                  : 'EXE'}
                              </span>
                            </div>
                            <div className="app-path-candidate-target">{candidate.target}</div>
                            {!candidate.supports_multi_instance ? (
                              <div className="app-path-candidate-note">
                                {t(
                                  'appPath.missing.defaultOnly',
                                  '仅适用于默认桌面端；应用多开请选择真实 Claude.exe',
                                )}
                              </div>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : null}
                {appPathActionError ? (
                  <p className="app-path-missing-error">
                    {t('messages.switchFailed', { error: appPathActionError })}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => setAppPathMissing(null)}
                disabled={appPathMissingBusy}
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSaveMissingAppPath}
                disabled={appPathMissingBusy || !appPathDraft.trim()}
              >
                {t('common.save', '保存')}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* 顶部固定拖拽区域 */}
      <div
        className="drag-region"
        data-tauri-drag-region
        onMouseDown={handleDragStart}
      />
      <IndustrialChrome page={page} />

      {/* 左侧悬浮导航 */}
      <SideNav
        page={page}
        setPage={setPage}
        onOpenPlatformLayout={openPlatformLayoutModal}
        easterEggClickCount={easterEggClickCount}
        onEasterEggTriggerClick={handleBreakoutEntryTriggerClick}
        hasBreakoutSession={hasBreakoutSession}
        onOpenLogViewer={() => setShowLogViewer(true)}
      />

      {sideNavLayoutMode !== 'classic' && (
        <button
          className="log-entry-fab"
          onClick={() => setShowLogViewer(true)}
          title={t('manual.dataPrivacy.keywords.5', '日志')}
          aria-label={t('manual.dataPrivacy.keywords.5', '日志')}
        >
          <FileText size={18} />
        </button>
      )}

      <Suspense fallback={null}>
        <PlatformLayoutModal
          open={showPlatformLayoutModal}
          requestedEditGroupId={platformLayoutRequestedGroupId}
          onClose={() => {
            setShowPlatformLayoutModal(false);
            setPlatformLayoutRequestedGroupId(null);
          }}
        />
        <LogViewerModal
          open={showLogViewer}
          onClose={() => setShowLogViewer(false)}
        />
      </Suspense>

      <div
        className={`main-wrapper${pageTransitionPhase === 'idle' ? '' : ` page-transition-${pageTransitionPhase}`}`}
        data-page={page}
        aria-busy={pageTransitionPhase !== 'idle'}
      >
        {/* removed promo banner */}
        {/* overview 现在是合并后的账号总览页面 */}
        <Suspense fallback={suspenseFallback}>
          {page === 'dashboard' && (
            <DashboardPage
              onNavigate={setPage}
              onOpenPlatformLayout={openPlatformLayoutModal}
              onEasterEggTriggerClick={handleBreakoutEntryTriggerClick}
            />
          )}
          {page === 'overview' && <AccountsPage onNavigate={setPage} />}
          {page === 'codex' && <CodexAccountsPage />}
          {page === 'claude' && <ClaudeAccountsPage subPlatform="desktop" />}
          {page === 'claude-cli' && <ClaudeAccountsPage subPlatform="cli" />}
          {page === 'codex-api-service' && <CodexApiServicePage />}
          {page === 'multi-model-api-service' && <MultiModelApiServicePage />}
          {page === 'jimeng-api-service' && (
            <JimengApiServicePage onOpenCanvas={() => setPage('jimeng-infinite-canvas')} />
          )}
          {page === 'jimeng-infinite-canvas' && <JimengInfiniteCanvasPage onNavigate={setPage} />}
          {page === 'claude-web-api' && <ClaudeWebApiPage />}
          {page === 'github-copilot' && <GitHubCopilotAccountsPage />}
          {page === 'windsurf' && <WindsurfAccountsPage />}
          {page === 'kiro' && <KiroAccountsPage />}
          {page === 'cursor' && <CursorAccountsPage />}
          {page === 'gemini' && <GeminiAccountsPage />}
          {page === 'codebuddy' && <CodebuddyAccountsPage />}
          {page === 'codebuddy-cn' && <CodebuddyCnAccountsPage />}
          {page === 'qoder' && <QoderAccountsPage />}
          {page === 'trae' && <TraeAccountsPage platformId="trae" />}
          {page === 'trae-solo' && <TraeAccountsPage platformId="trae_solo" />}
          {page === 'trae-cn' && <TraeAccountsPage platformId="trae_cn" />}
          {page === 'trae-solo-cn' && <TraeAccountsPage platformId="trae_solo_cn" />}
          {page === 'workbuddy' && <WorkbuddyAccountsPage />}
          {page === 'zed' && <ZedAccountsPage />}
          {page === 'instances' && <InstancesPage onNavigate={setPage} />}
          {page === 'wakeup' && <WakeupTasksPage onNavigate={setPage} />}
          {page === 'verification' && <WakeupVerificationPage onNavigate={setPage} />}
          {page === '2fa' && <TwoFactorAuthPage />}
          {page === 'manual' && (
            <ManualPage
              onNavigate={setPage}
              onOpenPlatformLayout={openPlatformLayoutModal}
            />
          )}
          {page === 'settings' && <SettingsPage />}
        </Suspense>
      </div>
      </div>
    </StartupPerformanceProvider>
  );
}

function App({ startupReady = true }: { startupReady?: boolean }) {
  const windowLabel =
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
      ? getCurrentWindow().label
      : 'main';
  if (windowLabel === 'floating-card' || windowLabel.startsWith('instance-floating-card-')) {
    return <><FloatingCardWindow /><SignatureCursorLayer /></>;
  }
  if (windowLabel === 'status-window') {
    return <><StatusWindow /><PetFishCursorLayer /></>;
  }

  return <MainApp startupReady={startupReady} />;
}

export default App;
