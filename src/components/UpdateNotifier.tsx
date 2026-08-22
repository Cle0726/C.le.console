import { useEffect, useMemo, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { Channel, invoke } from '@tauri-apps/api/core';
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

type UpdateDownloadEvent =
  | {
      event: 'Started';
      data: {
        contentLength?: number | null;
      };
    }
  | {
      event: 'Progress';
      data: {
        chunkLength: number;
      };
    }
  | {
      event: 'DownloadFinished';
      data?: null;
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

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let current = value;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || current >= 100 ? 0 : 1;
  return `${current.toFixed(digits)} ${units[unitIndex]}`;
}

export function UpdateNotifier() {
  const [currentVersion, setCurrentVersion] = useState('');
  const [release, setRelease] = useState<GitHubRelease | null>(null);
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [installStatus, setInstallStatus] = useState('');
  const [updateError, setUpdateError] = useState('');

  const latestVersion = useMemo(
    () => normalizeVersion(release?.tag_name || ''),
    [release?.tag_name],
  );

  const progressPercent = useMemo(() => {
    if (totalBytes <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((downloadedBytes / totalBytes) * 100)));
  }, [downloadedBytes, totalBytes]);

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
    if (installing) return;
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

  const handleInstallUpdate = async () => {
    if (installing) return;

    setInstalling(true);
    setUpdateError('');
    setDownloadedBytes(0);
    setTotalBytes(0);
    setInstallStatus('正在连接更新服务器…');

    let downloaded = 0;
    let total = 0;
    const onEvent = new Channel<UpdateDownloadEvent>();
    onEvent.onmessage = (message) => {
      if (message.event === 'Started') {
        total = message.data.contentLength ?? 0;
        setTotalBytes(total);
        setInstallStatus('正在下载并验证更新包…');
        return;
      }

      if (message.event === 'Progress') {
        downloaded += message.data.chunkLength;
        setDownloadedBytes(downloaded);
        return;
      }

      if (message.event === 'DownloadFinished') {
        if (total > 0) setDownloadedBytes(total);
        setInstallStatus('下载完成，正在安装。程序会自动关闭并重新启动…');
      }
    };

    try {
      await invoke('install_app_update', { onEvent });
      setInstallStatus('更新已安装，正在重新启动…');
    } catch (error) {
      console.error('[Update] 自动更新失败:', error);
      setUpdateError(String(error));
      setInstallStatus('');
      setInstalling(false);
    }
  };

  if (!release) {
    return checking ? <span className="update-notifier-sr-only">正在检查更新</span> : null;
  }

  const releaseTitle = release.name?.trim() || `C.le.控制台 v${latestVersion}`;
  const releaseNotes = release.body?.trim() || '新版本已经发布，可直接下载并安装。';

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
            disabled={installing}
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

        {installing && (
          <div className="update-notifier-progress-block" aria-live="polite">
            <div className="update-notifier-progress-meta">
              <span>{installStatus}</span>
              {totalBytes > 0 && (
                <span>
                  {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)} · {progressPercent}%
                </span>
              )}
            </div>
            <div className="update-notifier-progress-track">
              <div
                className={`update-notifier-progress-fill${totalBytes <= 0 ? ' is-indeterminate' : ''}`}
                style={totalBytes > 0 ? { width: `${progressPercent}%` } : undefined}
              />
            </div>
          </div>
        )}

        {updateError && (
          <div className="update-notifier-error" role="alert">
            自动更新失败：{updateError}
          </div>
        )}

        <div className="update-notifier-actions">
          {updateError ? (
            <button
              type="button"
              className="update-notifier-secondary"
              onClick={() => void handleOpenRelease()}
              disabled={opening || installing}
            >
              {opening ? <RefreshCw size={16} className="update-notifier-spin" /> : <Download size={16} />}
              {opening ? '正在打开…' : '手动下载'}
            </button>
          ) : (
            <button
              type="button"
              className="update-notifier-secondary"
              onClick={handleDismiss}
              disabled={installing}
            >
              稍后提醒
            </button>
          )}
          <button
            type="button"
            className="update-notifier-primary"
            onClick={() => void handleInstallUpdate()}
            disabled={installing}
          >
            {installing ? <RefreshCw size={16} className="update-notifier-spin" /> : <Download size={16} />}
            {installing ? '正在更新…' : updateError ? '重试自动更新' : '立即更新'}
          </button>
        </div>
      </section>
    </div>
  );
}
