import {
  Gauge,
  Moon,
  PanelTopOpen,
  RefreshCw,
  Sun,
  X,
} from 'lucide-react';
import type { EgressSourceId } from '../data/egressMonitor';

export type CompactQuotaItem = {
  key: string;
  label: string;
  percentage: number | null;
  resetText?: string;
};

export type CompactRouteItem = {
  id: EgressSourceId;
  label: string;
  short: string;
  expectedRoute: string;
  actualRoute: string;
  rule: string;
  status: 'matched' | 'mismatch' | 'unknown' | 'exempt';
};

type CompactStatusPanelProps = {
  accountLabel: string;
  planLabel: string;
  quotaItems: CompactQuotaItem[];
  routeItems: CompactRouteItem[];
  checkedAt: Date;
  theme: 'day' | 'night';
  performanceMode: 'full' | 'lite';
  refreshing?: boolean;
  refreshError?: string | null;
  onRefresh: () => void;
  onRestoreWindow: () => void;
  onTogglePerformanceMode: () => void;
  onToggleTheme: () => void;
  onClose: () => void;
};

function clampPercentage(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function routeDisplayName(route: string) {
  if (route.startsWith('未观测')) return '未观测';
  return route.replace(/\s*\/\s*/g, ' · ');
}

function routeStatusText(status: CompactRouteItem['status']) {
  switch (status) {
    case 'mismatch': return '异常';
    case 'matched': return '匹配';
    case 'exempt': return '豁免';
    default: return '待观测';
  }
}

export function CompactStatusPanel({
  planLabel,
  quotaItems,
  routeItems,
  checkedAt,
  theme,
  performanceMode,
  refreshing = false,
  refreshError,
  onRefresh,
  onRestoreWindow,
  onTogglePerformanceMode,
  onToggleTheme,
  onClose,
}: CompactStatusPanelProps) {
  const primaryQuota = clampPercentage(quotaItems[0]?.percentage ?? null);
  return (
    <section
      className="compact-status-panel"
      aria-label="模型额度与网络出口 / Model quota and network egress"
    >
      <header
        className="compact-status-titlebar"
      >
        <div
          className="compact-status-brand"
          data-tauri-drag-region
        >
          <strong>C.le.</strong>
          <span>状态窗 <small>/ STATUS</small></span>
        </div>
        <div
          className="compact-status-titlebar-meta"
          data-tauri-drag-region
        >
          <time>{checkedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
        </div>
        <div
          className="compact-status-window-actions"
          data-status-window-no-drag="true"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={onRestoreWindow}
            aria-label="恢复主窗口 / Restore main window"
            title="窗口化 / WINDOW"
          >
            <PanelTopOpen size={16} />
          </button>
          <button
            type="button"
            data-active={performanceMode === 'lite'}
            onClick={onTogglePerformanceMode}
            aria-label={performanceMode === 'lite' ? '退出简模式 / Restore full effects' : '启用简模式 / Lite mode'}
            aria-pressed={performanceMode === 'lite'}
            title={performanceMode === 'lite' ? '完整效果 / FULL' : '简模式 / LITE'}
          >
            <Gauge size={16} />
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'night' ? '切换日间模式 / Switch to day' : '切换黑夜模式 / Switch to night'}
            title={theme === 'night' ? '日间模式 / DAY' : '黑夜模式 / NIGHT'}
          >
            {theme === 'night' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button type="button" onClick={onClose} aria-label="隐藏状态窗 / Hide status window" title="隐藏 / HIDE">
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="compact-status-body">
        <article className="compact-status-quota" aria-label="当前模型额度 / Current model quota">
          <em className="compact-plan-badge">{planLabel || '--'}</em>

          <div className="compact-quota-sculpture" aria-label={primaryQuota == null ? '暂无额度数据' : `剩余额度 ${primaryQuota}%`}>
            <div className="compact-quota-orbit compact-quota-orbit-outer" aria-hidden="true">
              <i /><i /><i />
            </div>
            <div className="compact-quota-orbit compact-quota-orbit-inner" aria-hidden="true">
              <i /><i />
            </div>
            <div className="compact-quota-particles" aria-hidden="true">
              <i /><i /><i /><i /><i /><i />
            </div>
            <i className="compact-quota-shape compact-quota-shape-one" />
            <i className="compact-quota-shape compact-quota-shape-two" />
            <i className="compact-quota-shape compact-quota-shape-three" />
            <i className="compact-quota-energy-sweep" aria-hidden="true" />
            <div className="compact-quota-core">
              <strong>{primaryQuota == null ? '--' : primaryQuota}</strong>
              <small>{primaryQuota == null ? '暂无数据' : '% 剩余'}</small>
            </div>
          </div>

          <div className="compact-quota-list">
            {(quotaItems.length > 0 ? quotaItems.slice(0, 2) : [
              { key: 'empty', label: '暂无额度 / NO DATA', percentage: null },
            ]).map((item) => {
              const percentage = clampPercentage(item.percentage);
              return (
                <div key={item.key} className="compact-quota-row">
                  <div><span>{item.label}</span><b>{percentage == null ? '--' : `${percentage}%`}</b></div>
                  <div className="compact-quota-track"><i style={{ width: `${percentage ?? 0}%` }} /></div>
                </div>
              );
            })}
          </div>
        </article>

        <article className="compact-status-network" aria-label="网络代理出口 / Network proxy egress">
          <div className="compact-status-section-heading">
            <span><b>实时监测节点</b><small>LIVE ROUTE NODES</small></span>
            <span className="compact-live-monitor" aria-label="实时监测运行中">
              <i aria-hidden="true" />
              实时
            </span>
          </div>

          <div className="compact-route-list">
            {routeItems.map((item) => (
              <div
                key={item.id}
                className={`compact-route-row is-${item.status}`}
                title={`${item.label} · ${item.actualRoute} · ${item.rule}`}
              >
                <span className="compact-route-source"><b>{item.label}</b></span>
                <span className="compact-route-result">
                  <b>{routeDisplayName(item.actualRoute)}</b>
                  <small>{item.rule}</small>
                </span>
                <span className="compact-route-verdict" aria-label={item.status === 'mismatch' ? '出口不一致' : item.status === 'unknown' ? '出口未观测' : '出口正常'}>
                  <i className="compact-route-node-dot" aria-hidden="true" />
                  <small>{routeStatusText(item.status)}</small>
                </span>
              </div>
            ))}
          </div>
        </article>
      </div>

      <footer className="compact-status-footer">
        <span>{refreshError || `最近检测 · ${checkedAt.toLocaleTimeString('zh-CN', { hour12: false })}`}</span>
        <button type="button" onClick={onRefresh} disabled={refreshing} aria-label="刷新额度与出口 / Refresh quota and egress">
          <RefreshCw size={14} className={refreshing ? 'is-spinning' : undefined} />
          <span>{refreshing ? '检测中' : '重新检测'}</span>
        </button>
      </footer>
    </section>
  );
}
