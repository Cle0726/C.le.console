import { invoke } from '@tauri-apps/api/core';

export const INFINITE_CANVAS_ORIGIN = 'http://127.0.0.1:3000';
export const INFINITE_CANVAS_URLS = {
  projects: `${INFINITE_CANVAS_ORIGIN}/static/canvas-list.html?cle_embed=1`,
  assets: `${INFINITE_CANVAS_ORIGIN}/static/asset-manager.html?cle_embed=1`,
  api: `${INFINITE_CANVAS_ORIGIN}/static/api-settings.html?cle_embed=1`,
} as const;
export const INFINITE_CANVAS_WORKSPACE_URL = INFINITE_CANVAS_URLS.projects;

export interface InfiniteCanvasRuntimeState {
  running: boolean;
  port: number;
  rootPath: string | null;
  version: string | null;
  source: string;
}

export interface InfiniteCanvasAppInfo {
  version?: string;
  repo_url?: string;
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function requestAppInfo(timeoutMs = 2_500): Promise<InfiniteCanvasAppInfo> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${INFINITE_CANVAS_ORIGIN}/api/app-info`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json() as InfiniteCanvasAppInfo;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function probeInfiniteCanvas(): Promise<InfiniteCanvasRuntimeState> {
  try {
    const info = await requestAppInfo();
    return {
      running: true,
      port: 3000,
      rootPath: null,
      version: info.version ?? null,
      source: info.repo_url ?? 'hero8152/Infinite-Canvas',
    };
  } catch (networkError) {
    if (isTauriRuntime()) {
      try {
        return await invoke<InfiniteCanvasRuntimeState>('infinite_canvas_get_state');
      } catch {
        // Keep the original network failure as the authoritative state.
      }
    }
    return {
      running: false,
      port: 3000,
      rootPath: null,
      version: null,
      source: networkError instanceof Error ? networkError.message : String(networkError),
    };
  }
}

export async function startInfiniteCanvas(): Promise<InfiniteCanvasRuntimeState> {
  if (!isTauriRuntime()) {
    throw new Error('当前浏览器预览不能启动本机进程，请从 C.le. 控制台打开。');
  }
  return await invoke<InfiniteCanvasRuntimeState>('infinite_canvas_start');
}
