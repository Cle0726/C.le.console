import { useEffect, useMemo, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Download, RefreshCw, X } from 'lucide-react';
import './UpdateNotifier.css';

type GitHubRelease = {
  tag_name?: string;
  name?: string | null;
  body?: string | null;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  published_at?: string | null;
};

const LATEST_RELEASE_API = 'https://api.github.com/repos/Cle0726/C.le.console/releases/latest';
const RELEASES_PAGE = 'https://github.com/Cle0726/C.le.console/releases';
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;
const CHECK_DELAY_MS = 3200;

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '').split('+', 1)[0];
}

function versionParts(version: string): number[] {
  const core = normalizeVersion(version).split('-', 1)[0];
  return core.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

function isNewerVersion(candidate: string, current: string): boolean {
  const candidateParts = versionParts(candidate);
  const currentParts = versionParts(current);
  const length = Math.max(candidateParts.length, currentParts.length);

  for (let index = 0; index < length; index += 1) {
    const left = candidateParts[index] ?? 0;
    const right = currentParts[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }

  return false;
}

function isWindowsDesktop(): boolean {
  return '__TAURI_INTERNALS__' in window && /Windows/i.test(navigator.userAgent);
}

function dismissedStorageKey(version: string): string {
  return `cle-console:update-dismissed:${normalizeVersion(version)}`;
}

function wasRecentlyDismissed(version: string): boolean {
  try {
    const raw = window.localStorage.getItem(dismissedStorageKey(version));
    if (!raw) return false;
    const dismissedAt = Number(raw);
    return Number.isFinite(dismissedAt) && Date.now() - dismissedAt < REMIND_AFTER_MS;
  } catch {
    return false;
  }
}

function rememberDismissed(version: string): void {
  try {
    window.localStorage.setItem(dismissedStorageKey(version), String(Date.now()));
  } catch {
    // Local storage can be unavailable in hardened WebView environments.
  }
}

export function UpdateNotifier() {
  const [currentVersion, setCurrentVersion] = useState('');
  const [release, setRelease] = useState<GitHubRelease | null>(null);
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);

  const latestVersion = useMemo(
    () => normalizeVersion(release?.tag_name || ''),
    [release?.tag_name],
  );

  useEffect(() => {
    if (!isWindowsDesktop()) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setChecking(true);
      void Promise.all([
        getVersion(),
        fetch(LATEST_RELEASE_API, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
          },
          cache: 'no-store',
        }).then(async (response) => {
          if (!response.ok) {
            throw new Error(`GitHub release check failed: HTTP ${response.status}`);
          }
          return response.json() as Promise<GitHubRelease>;
        }),
      ])
        .then(([installedVersion, latestRelease]) => {
          if (cancelled) return;
          setCurrentVersion(installedVersion);

          const candidateVersion = latestRelease.tag_name || '';
          if (
            latestRelease.draft
            || latestRelease.prerelease
            || !candidateVersion
            || !isNewerVersion(candidateVersion, installedVersion)
            || wasRecentlyDismissed(candidateVersion)
          ) {
            return;
          }

          setRelease(latestRelease);
        })
        .catch((error) => {
          console.warn('[Update] 检查 GitHub Release 更新失败:', error);
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, CHECK_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const handleDismiss = () => {
    if (release?.tag_name) rememberDismissed(release.tag_name);
    setRelease(null);
  };

  const handleOpenRelease = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await openUrl(release?.html_url || RELEASES_PAGE);
    } catch (error) {
      console.error('[Update] 打开 GitHub Release 页面失败:', error);
    } finally {
      setOpening(false);
    }
  };

  if (!release) {
    return checking ? <span className="update-notifier-sr-only">正在检查更新</span> : null;
  }

  const releaseTitle = release.name?.trim() || `C.le.控制台 v${latestVersion}`;
  const releaseNotes = release.body?.trim() || '新版本已经发布，可前往 GitHub Releases 下载并安装。';

  return (
    <div className="update-notifier-overlay" role="presentation">
      <section
        className="update-notifier-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-notifier-title"
      >
        <div className="update-notifier-header">
          <div>
            <div className="update-notifier-eyebrow">软件更新</div>
            <h2 id="update-notifier-title">发现新版本 v{latestVersion}</h2>
          </div>
          <button
            type="button"
            className="update-notifier-icon-button"
            onClick={handleDismiss}
            aria-label="稍后提醒"
          >
            <X size={18} />
          </button>
        </div>

        <div className="update-notifier-version-row">
          <span>当前版本 v{currentVersion || '—'}</span>
          <span className="update-notifier-arrow">→</span>
          <strong>最新版本 v{latestVersion}</strong>
        </div>

        <div className="update-notifier-release-title">{releaseTitle}</div>
        <div className="update-notifier-notes">{releaseNotes}</div>

        <div className="update-notifier-actions">
          <button type="button" className="update-notifier-secondary" onClick={handleDismiss}>
            稍后提醒
          </button>
          <button
            type="button"
            className="update-notifier-primary"
            onClick={() => void handleOpenRelease()}
            disabled={opening}
          >
            {opening ? <RefreshCw size={16} className="update-notifier-spin" /> : <Download size={16} />}
            {opening ? '正在打开…' : '下载新版本'}
          </button>
        </div>
      </section>
    </div>
  );
}
