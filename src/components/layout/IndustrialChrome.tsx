import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Page } from '../../types/navigation';
import {
  applyVisualTheme,
  readVisualTheme,
  saveVisualTheme,
  VISUAL_THEME_STORAGE_KEY,
  type VisualTheme,
} from '../../utils/visualTheme';
import {
  applyPerformanceMode,
  readPerformanceMode,
  savePerformanceMode,
  PERFORMANCE_MODE_STORAGE_KEY,
  type PerformanceMode,
} from '../../utils/performanceMode';

const PAGE_SEQUENCE: readonly Page[] = [
  'dashboard',
  'overview',
  'codex',
  'claude',
  'claude-cli',
  'codex-api-service',
  'github-copilot',
  'windsurf',
  'kiro',
  'cursor',
  'gemini',
  'codebuddy',
  'codebuddy-cn',
  'qoder',
  'trae',
  'trae-solo',
  'trae-cn',
  'trae-solo-cn',
  'workbuddy',
  'zed',
  'instances',
  'accounts',
  'wakeup',
  'verification',
  '2fa',
  'manual',
  'settings',
];

interface IndustrialChromeProps {
  page: Page;
}

function getPageSequence(page: Page): string {
  const index = PAGE_SEQUENCE.indexOf(page);
  return String(index >= 0 ? index + 1 : 0).padStart(3, '0');
}

function isMacOSPlatform(): boolean {
  const navWithUAData = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = navWithUAData.userAgentData?.platform || navigator.platform || '';
  return platform.toLowerCase().includes('mac');
}

export function IndustrialChrome({ page }: IndustrialChromeProps) {
  const { i18n } = useTranslation();
  const [now, setNow] = useState(() => new Date());
  const [visualTheme, setVisualTheme] = useState<VisualTheme>(() => readVisualTheme());
  const [performanceMode, setPerformanceMode] = useState<PerformanceMode>(() => readPerformanceMode());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    applyVisualTheme(visualTheme);
  }, [visualTheme]);

  useEffect(() => {
    applyPerformanceMode(performanceMode);
  }, [performanceMode]);

  useEffect(() => {
    const syncVisualTheme = (event: StorageEvent) => {
      if (event.key === VISUAL_THEME_STORAGE_KEY) {
        setVisualTheme(readVisualTheme());
      }
      if (event.key === PERFORMANCE_MODE_STORAGE_KEY) {
        setPerformanceMode(readPerformanceMode());
      }
    };

    window.addEventListener('storage', syncVisualTheme);
    return () => window.removeEventListener('storage', syncVisualTheme);
  }, []);

  const toggleVisualTheme = () => {
    const nextTheme: VisualTheme = visualTheme === 'night' ? 'day' : 'night';
    setVisualTheme(nextTheme);
    saveVisualTheme(nextTheme);
  };

  const togglePerformanceMode = () => {
    const nextMode: PerformanceMode = performanceMode === 'lite' ? 'full' : 'lite';
    setPerformanceMode(nextMode);
    savePerformanceMode(nextMode);
  };

  const toggleMacWindowMode = async () => {
    const currentWindow = getCurrentWindow();
    try {
      if (await currentWindow.isFullscreen()) {
        await currentWindow.setFullscreen(false);
        return;
      }
      if (await currentWindow.isMaximized()) {
        await currentWindow.unmaximize();
        return;
      }
      await currentWindow.maximize();
    } catch (error) {
      console.warn('[Window] macOS 窗口模式切换失败:', error);
    }
  };

  const dateParts = useMemo(() => {
    const locale = i18n.resolvedLanguage || i18n.language || undefined;
    return {
      weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(now),
      date: new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'long' }).format(now),
      year: new Intl.DateTimeFormat(locale, { year: 'numeric' }).format(now),
      time: new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(now),
    };
  }, [i18n.language, i18n.resolvedLanguage, now]);

  return (
    <div className="industrial-chrome">
      <div className="industrial-chrome-date">
        <span className="industrial-chrome-weekday">{dateParts.weekday}</span>
        <span className="industrial-chrome-rule" />
        <span>{dateParts.date}</span>
      </div>
      <div className="industrial-chrome-status">
        <span className="industrial-chrome-signal" />
        <span>LOCAL CONTROL</span>
        <span className="industrial-chrome-time">{dateParts.time}</span>
      </div>
      <div className="industrial-chrome-year">
        {isMacOSPlatform() && (
          <button
            type="button"
            className="industrial-lite-toggle industrial-window-toggle"
            aria-label="切换窗口模式 / Toggle window mode"
            title="窗口化 / 最大化"
            onClick={() => void toggleMacWindowMode()}
          >
            <span>窗</span><small>WIN</small>
          </button>
        )}
        <button
          type="button"
          className="industrial-lite-toggle"
          data-active={performanceMode === 'lite'}
          aria-label={performanceMode === 'lite' ? '退出简洁模式 / Restore full effects' : '启用简洁模式 / Reduce memory usage'}
          aria-pressed={performanceMode === 'lite'}
          title={performanceMode === 'lite' ? '完整效果 / Full' : '简洁模式 / Lite'}
          onClick={togglePerformanceMode}
        >
          <span className="industrial-lite-bars" aria-hidden="true"><i /><i /><i /></span>
          <span>简</span><small>LITE</small>
        </button>
        <button
          type="button"
          className="industrial-theme-toggle"
          data-mode={visualTheme}
          aria-label={visualTheme === 'night' ? '切换到日间模式 / Switch to day mode' : '切换到黑夜模式 / Switch to night mode'}
          aria-pressed={visualTheme === 'night'}
          title={visualTheme === 'night' ? '日间模式 / Day' : '黑夜模式 / Night'}
          onClick={toggleVisualTheme}
        >
          <span className="industrial-theme-track" aria-hidden="true">
            <span className="industrial-theme-stars" />
            <span className="industrial-theme-core" />
          </span>
        </button>
        <span className="industrial-chrome-year-time">{dateParts.time}</span>
        <span className="industrial-chrome-year-rule" />
        <span>{dateParts.year}</span>
      </div>
      <span className="industrial-chrome-index">{getPageSequence(page)}</span>
    </div>
  );
}
