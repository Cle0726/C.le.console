import { useCallback, useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  ArrowLeft,
  ExternalLink,
  FolderKanban,
  Library,
  LoaderCircle,
  PanelsTopLeft,
  RefreshCw,
  ServerCog,
  SlidersHorizontal,
} from 'lucide-react';
import {
  INFINITE_CANVAS_URLS,
  probeInfiniteCanvas,
  startInfiniteCanvas,
  type InfiniteCanvasRuntimeState,
} from '../services/infiniteCanvasService';
import type { Page } from '../types/navigation';
import './JimengInfiniteCanvasPage.css';

interface JimengInfiniteCanvasPageProps {
  onNavigate: (page: Page) => void;
}

type WorkspaceSurface = keyof typeof INFINITE_CANVAS_URLS;

export function JimengInfiniteCanvasPage({ onNavigate }: JimengInfiniteCanvasPageProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const runtimeRef = useRef<InfiniteCanvasRuntimeState | null>(null);
  const probeFailures = useRef(0);
  const repairingRef = useRef(false);
  const lastAutomaticRepairAt = useRef(0);
  const [runtime, setRuntime] = useState<InfiniteCanvasRuntimeState | null>(null);
  const [surface, setSurface] = useState<WorkspaceSurface>('projects');
  const [frameKey, setFrameKey] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const probe = useCallback(async () => {
    const next = await probeInfiniteCanvas();
    if (next.running) {
      probeFailures.current = 0;
      runtimeRef.current = next;
      setRuntime(next);
    } else {
      probeFailures.current += 1;
      const shouldCommitOffline =
        runtimeRef.current === null
        || runtimeRef.current.running === false
        || probeFailures.current >= 3;
      if (shouldCommitOffline) {
        runtimeRef.current = next;
        setRuntime(next);
      }
    }
    return next;
  }, []);

  const repairAndStart = useCallback(async (automatic = false) => {
    if (repairingRef.current) return;
    repairingRef.current = true;
    setRepairing(true);
    if (!automatic) setError(null);
    try {
      const next = await startInfiniteCanvas();
      probeFailures.current = 0;
      runtimeRef.current = next;
      setRuntime(next);
      if (!next.running) {
        throw new Error('Infinite Canvas 服务启动后未通过端口健康检查。');
      }
      setFrameReady(false);
      setFrameKey((value) => value + 1);
    } catch (nextError) {
      if (!automatic) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      repairingRef.current = false;
      setRepairing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const checkAndRecover = async () => {
      const wasKnown = runtimeRef.current !== null;
      const next = await probe();
      if (
        !cancelled
        && !next.running
        && '__TAURI_INTERNALS__' in window
        && (!wasKnown || probeFailures.current >= 3)
        && Date.now() - lastAutomaticRepairAt.current >= 30_000
      ) {
        lastAutomaticRepairAt.current = Date.now();
        await repairAndStart(true);
      }
    };
    void checkAndRecover();
    const timer = window.setInterval(() => void checkAndRecover(), 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [probe, repairAndStart]);

  const applyEmbeddedTheme = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: 'studio-theme', theme: 'dark' },
      '*',
    );
    frameRef.current?.contentWindow?.postMessage(
      { type: 'studio-ui-scale', mode: 'auto' },
      '*',
    );
  }, []);

  const reloadWorkspace = useCallback(() => {
    setError(null);
    setFrameReady(false);
    setFrameKey((value) => value + 1);
    void probe();
  }, [probe]);

  const openSurface = useCallback((nextSurface: WorkspaceSurface) => {
    setSurface(nextSurface);
    setFrameReady(false);
    setFrameKey((value) => value + 1);
  }, []);

  const openInBrowser = useCallback(async () => {
    const url = INFINITE_CANVAS_URLS[surface];
    try {
      await openUrl(url);
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  }, [surface]);

  const isOnline = runtime?.running === true;
  const isChecking = runtime === null;
  const frameUrl = INFINITE_CANVAS_URLS[surface];

  return (
    <section className="infinite-workspace-page" aria-label="Infinite Canvas 工作台">
      <header className="infinite-workspace-bar">
        <div className="infinite-workspace-identity">
          <button
            className="infinite-workspace-icon-button"
            type="button"
            title="返回网页创作中心"
            onClick={() => onNavigate('jimeng-api-service')}
          >
            <ArrowLeft size={17} />
          </button>
          <PanelsTopLeft size={17} aria-hidden="true" />
          <strong>Infinite Canvas</strong>
          <span className={`infinite-workspace-status${isOnline ? ' is-online' : ''}`}>
            <i />
            {isChecking
              ? '正在检测'
              : isOnline
                ? `已连接${runtime?.version ? ` · ${runtime.version}` : ''}`
                : '服务离线'}
          </span>
        </div>

        <nav className="infinite-workspace-nav" aria-label="Infinite Canvas 功能">
          <button
            type="button"
            className={surface === 'projects' ? 'is-active' : ''}
            onClick={() => openSurface('projects')}
          >
            <FolderKanban size={15} />
            <span>项目</span>
          </button>
          <button
            type="button"
            className={surface === 'assets' ? 'is-active' : ''}
            onClick={() => openSurface('assets')}
          >
            <Library size={15} />
            <span>资产</span>
          </button>
          <button
            type="button"
            className={surface === 'api' ? 'is-active' : ''}
            onClick={() => openSurface('api')}
          >
            <SlidersHorizontal size={15} />
            <span>模型与 API</span>
          </button>
        </nav>

        <div className="infinite-workspace-actions">
          <button type="button" onClick={reloadWorkspace} title="刷新工作台">
            <RefreshCw size={15} />
            <span>刷新</span>
          </button>
          <button type="button" onClick={() => onNavigate('jimeng-api-service')} title="返回 C.le 网页创作中心">
            <ServerCog size={15} />
            <span>即梦服务</span>
          </button>
          <button type="button" onClick={() => void openInBrowser()} title="在独立浏览器打开">
            <ExternalLink size={15} />
            <span>独立打开</span>
          </button>
        </div>
      </header>

      <div className="infinite-workspace-stage">
        {isOnline && (
          <iframe
            key={`${surface}-${frameKey}`}
            ref={frameRef}
            className={`infinite-workspace-frame${frameReady ? ' is-ready' : ''}`}
            src={frameUrl}
            title="Infinite Canvas 完整工作台"
            allow="clipboard-read; clipboard-write; fullscreen"
            onLoad={() => {
              applyEmbeddedTheme();
              window.setTimeout(applyEmbeddedTheme, 80);
              setFrameReady(true);
              setError(null);
            }}
          />
        )}

        {(isChecking || !isOnline || !frameReady) && (
          <div className="infinite-workspace-gate" role="status">
            <div className="infinite-workspace-gate-mark">
              {isChecking || repairing || isOnline
                ? <LoaderCircle className="spin" size={23} />
                : <PanelsTopLeft size={23} />}
            </div>
            <strong>
              {isChecking
                ? '正在检测 Infinite Canvas'
                : isOnline
                  ? '正在载入完整工作台'
                  : 'Infinite Canvas 未运行'}
            </strong>
            <p>
              {isChecking
                ? '正在检查运行时、项目数据和本地服务状态。'
                : isOnline
                ? '正在恢复项目、画布、资产库与工作流状态。'
                : 'C.le. 可自动启动 F:\\Infinite-Canvas；服务独立运行，关闭控制台不会中断已有任务。'}
            </p>
            {!isChecking && !isOnline && (
              <button type="button" onClick={() => void repairAndStart()} disabled={repairing}>
                {repairing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                {repairing ? '正在修复并启动' : '启动并重新连接'}
              </button>
            )}
            {error && <small>{error}</small>}
          </div>
        )}
      </div>

      <footer className="infinite-workspace-credit">
        基于 hero8152/Infinite-Canvas · 原项目功能与数据保持独立
      </footer>
    </section>
  );
}
