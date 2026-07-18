import {
  AlertTriangle,
  Check,
  Minus,
  Moon,
  RefreshCw,
  Route,
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
  refreshing?: boolean;
  refreshError?: string | null;
  onRefresh: () => void;
  onToggleTheme: () => void;
  onClose: () => void;
  onDragStart?: () => void;
};

function clampPercentage(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function routeShortName(route: string) {
  return route.split('/')[0]?.trim() || route;
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
  refreshing = false,
  refreshError,
  onRefresh,
  onToggleTheme,
  onClose,
  onDragStart,
}: CompactStatusPanelProps) {
  const primaryQuota = clampPercentage(quotaItems[0]?.percentage ?? null);
  const mismatches = routeItems.filter((item) => item.status === 'mismatch');
  const unknowns = routeItems.filter((item) => item.status === 'unknown');
  const hasMismatch = mismatches.length > 0;
  const hasUnknown = unknowns.length > 0;

  return (
    <section
      className={`compact-status-panel${hasMismatch ? ' has-mismatch' : ''}`}
      aria-label="模型额度与网络出口 / Model quota and network egress"
    >
      <header
        className="compact-status-titlebar"
        data-tauri-drag-region
        onDoubleClick={onDragStart}
      >
        <div className="compact-status-brand" data-tauri-drag-region>
          <strong>C.le.</strong>
          <span>状态窗 <small>/ STATUS</small></span>
        </div>
        <div className="compact-status-titlebar-meta" data-tauri-drag-region>
          <time>{checkedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
        </div>
        <div className="compact-status-window-actions">
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'night' ? '切换日间模式 / Switch to day' : '切换黑夜模式 / Switch to night'}
            title={theme === 'night' ? '日间模式 / DAY' : '黑夜模式 / NIGHT'}
          >
            {theme === 'night' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button type="button" onClick={onClose} aria-label="关闭状态窗 / Close status window" title="关闭 / CLOSE">
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="compact-status-body">
        <article className="compact-status-quota" aria-label="当前模型额度 / Current model quota">
          <em className="compact-plan-badge">{planLabel || '--'}</em>

          <div className="compact-quota-sculpture" aria-label={primaryQuota == null ? '暂无额度数据' : `剩余额度 ${primaryQuota}%`}>
            <i className="compact-quota-shape compact-quota-shape-one" />
            <i className="compact-quota-shape compact-quota-shape-two" />
            <i className="compact-quota-shape compact-quota-shape-three" />
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
            <span><b>出口线路</b><small>ROUTE &amp; RULE</small></span>
            <span className={hasMismatch ? 'compact-route-summary is-error' : hasUnknown ? 'compact-route-summary is-waiting' : 'compact-route-summary is-healthy'}>
              <Route size={14} aria-hidden="true" />
              {hasMismatch ? '需处理' : hasUnknown ? '检测中' : '已固定'}
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
                  <small>{routeStatusText(item.status)}</small>
                  {item.status === 'mismatch'
                    ? <AlertTriangle size={15} />
                    : item.status === 'unknown'
                      ? <Minus size={15} />
                      : <Check size={15} />}
                </span>
              </div>
            ))}
          </div>

          {hasMismatch ? (
            <div className="compact-route-alert" role="alert" aria-live="assertive">
              <AlertTriangle size={13} aria-hidden="true" />
              <span>
                <b>出口与设定不一致</b>
                <small>{routeShortName(mismatches[0].expectedRoute)} → {routeDisplayName(mismatches[0].actualRoute)}</small>
              </span>
            </div>
          ) : hasUnknown ? (
            <div className="compact-route-alert is-neutral" role="status" aria-live="polite">
              <Minus size={13} aria-hidden="true" />
              <span>
                <b>等待活动连接</b>
                <small>有流量后将自动识别实际线路</small>
              </span>
            </div>
          ) : null}
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
