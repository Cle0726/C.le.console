import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CircleDot,
  History,
  Monitor,
  Network,
  Pause,
  PanelTopOpen,
  Play,
  RefreshCw,
  Server,
  ShieldCheck,
  WifiOff,
} from 'lucide-react';
import { DashboardSceneHeader } from './DashboardShowcase';
import {
  EGRESS_SOURCE_DEFINITIONS,
  deriveEgressVerdict,
  getEgressSourceDefinition,
  type EgressHealth,
  type EgressSourceId,
} from '../data/egressMonitor';
import {
  getNetworkEgressSnapshot,
  type NetworkEgressActiveConnection,
  type NetworkEgressSnapshot,
  type NetworkEgressSourceSnapshot,
} from '../services/networkEgressService';
import { showStatusWindow } from '../services/statusWindowService';

type MonitorView = 'live' | 'details';

const SOURCE_Y: Record<EgressSourceId, number> = {
  'local-api': 34,
  chatgpt: 94,
  claude: 154,
  other: 214,
};

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** exponent;
  return `${amount >= 100 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`;
}

function routeShortName(route: string) {
  if (!route || route.startsWith('未观测')) return 'WAITING';
  return route.split('·')[0]?.split('/')[0]?.trim() || route;
}

function routeDetail(route: string) {
  if (!route || route.startsWith('未观测')) return 'NO ACTIVE SAMPLE';
  return route.split('·')[0]?.split('/').slice(1).join('/').trim() || 'LIVE ROUTE';
}

function sourceStatusLabel(status: EgressHealth) {
  if (status === 'mismatch') return '出口不一致 / MISMATCH';
  if (status === 'matched') return '实测命中 / MATCHED';
  if (status === 'exempt') return '仅展示 / EXEMPT';
  return '未观测 / NO SAMPLE';
}

function resultLabel(status: EgressHealth) {
  if (status === 'mismatch') return '出口不一致 / MISMATCH';
  if (status === 'matched') return '固定出口命中 / MATCH';
  if (status === 'exempt') return '其他线路 · 不告警 / EXEMPT';
  return '等待活动连接 / WAITING';
}

function SourceIcon({ source, size = 17 }: { source: EgressSourceId; size?: number }) {
  if (source === 'local-api') return <Server size={size} />;
  if (source === 'chatgpt' || source === 'claude') return <Monitor size={size} />;
  return <Network size={size} />;
}

function emptyMeasurement(id: EgressSourceId): NetworkEgressSourceSnapshot {
  return {
    id,
    observationState: 'not_observed',
    processNames: [],
    routes: [],
    nodes: [],
    rules: [],
    activeConnections: 0,
    downloadBytes: 0,
    uploadBytes: 0,
    publicIp: null,
  };
}

function connectionMeasurement(connection: NetworkEgressActiveConnection): NetworkEgressSourceSnapshot {
  return {
    id: connection.source,
    observationState: connection.route ? 'controller_observed' : 'not_observed',
    processNames: connection.process ? [connection.process] : [],
    routes: connection.route ? [connection.route] : [],
    nodes: connection.node ? [connection.node] : [],
    rules: connection.rule ? [connection.rule] : [],
    activeConnections: 1,
    downloadBytes: connection.downloadBytes,
    uploadBytes: connection.uploadBytes,
    publicIp: null,
  };
}

function elapsedSince(start: string | null) {
  if (!start) return '--:--';
  const elapsed = Date.now() - new Date(start).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return '--:--';
  const seconds = Math.floor(elapsed / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function TrafficEgressScene({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<MonitorView>('live');
  const [selectedSource, setSelectedSource] = useState<EgressSourceId | 'all'>('all');
  const [paused, setPaused] = useState(false);
  const [snapshot, setSnapshot] = useState<NetworkEgressSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [requestingSnapshot, setRequestingSnapshot] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [statusWindowError, setStatusWindowError] = useState<string | null>(null);
  const [incidentDetectedAt, setIncidentDetectedAt] = useState<Date | null>(null);
  const inspectorRef = useRef<HTMLDivElement | null>(null);
  const requestInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const [performanceMode, setPerformanceMode] = useState(
    () => document.documentElement.dataset.performanceMode ?? 'full',
  );

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setPerformanceMode(root.dataset.performanceMode ?? 'full');
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-performance-mode'] });
    return () => observer.disconnect();
  }, []);

  const refreshNow = useCallback(async () => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    if (mountedRef.current) setRequestingSnapshot(true);
    setSnapshotError(null);
    try {
      const nextSnapshot = await getNetworkEgressSnapshot();
      if (mountedRef.current) setSnapshot(nextSnapshot);
    } catch (error) {
      if (mountedRef.current) {
        setSnapshotError(`代理检测不可用 / DETECTION UNAVAILABLE · ${String(error)}`);
      }
    } finally {
      requestInFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        setRequestingSnapshot(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshNow();
    if (paused) return undefined;
    const interval = window.setInterval(() => {
      if (!document.hidden) void refreshNow();
    }, performanceMode === 'lite' ? 10_000 : 3_500);
    return () => window.clearInterval(interval);
  }, [paused, performanceMode, refreshNow]);

  const sourceSnapshots = useMemo(() => EGRESS_SOURCE_DEFINITIONS.map((definition) => {
    const measurement = snapshot?.sources.find((source) => source.id === definition.id)
      ?? emptyMeasurement(definition.id);
    return {
      ...definition,
      measurement,
      verdict: deriveEgressVerdict(definition, measurement),
    };
  }), [snapshot]);

  const mismatchSources = useMemo(
    () => sourceSnapshots.filter((source) => source.verdict.health === 'mismatch'),
    [sourceSnapshots],
  );
  const matchedSources = useMemo(
    () => sourceSnapshots.filter((source) => source.verdict.health === 'matched'),
    [sourceSnapshots],
  );
  const unknownSources = useMemo(
    () => sourceSnapshots.filter((source) => source.verdict.health === 'unknown'),
    [sourceSnapshots],
  );
  const primaryMismatch = mismatchSources[0] ?? null;

  useEffect(() => {
    if (primaryMismatch && !incidentDetectedAt) setIncidentDetectedAt(new Date());
    if (!primaryMismatch && incidentDetectedAt) setIncidentDetectedAt(null);
  }, [incidentDetectedAt, primaryMismatch]);

  const inspectedSource = selectedSource === 'all'
    ? sourceSnapshots[0]
    : sourceSnapshots.find((source) => source.id === selectedSource) ?? sourceSnapshots[0];

  const visibleConnections = useMemo(() => (snapshot?.activeConnections ?? []).filter(
    (connection) => selectedSource === 'all' || connection.source === selectedSource,
  ), [selectedSource, snapshot]);

  const lastChecked = snapshot?.capturedAt ? new Date(snapshot.capturedAt) : null;
  const primaryRoute = sourceSnapshots
    .filter((source) => !source.exemptFromMismatch)
    .flatMap((source) => source.measurement.routes)[0] ?? '未观测 / NO SAMPLE';
  const otherRoute = sourceSnapshots.find((source) => source.id === 'other')?.verdict.actualRoute
    ?? '未观测 / NO SAMPLE';
  const controllerLive = snapshot?.controller.status === 'connected';
  const controllerLabel = controllerLive
    ? `${(snapshot.controller.implementation ?? 'controller').toUpperCase()} · LIVE`
    : snapshot?.controller.status === 'unavailable'
      ? 'CONTROLLER · OFFLINE'
      : 'CONTROLLER · NOT FOUND';
  const proxyEndpoint = snapshot?.proxy.selectedEndpoint
    ?? snapshot?.proxy.selectedPacUrl
    ?? '未检测 / NOT DETECTED';
  const firstWarning = snapshot?.warnings[0]?.message ?? null;

  const locateMismatch = () => {
    if (!primaryMismatch) return;
    setView('live');
    setSelectedSource(primaryMismatch.id);
    window.requestAnimationFrame(() => {
      inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      inspectorRef.current?.focus({ preventScroll: true });
    });
  };

  const recheckMismatch = () => {
    void refreshNow();
    if (primaryMismatch) setSelectedSource(primaryMismatch.id);
  };

  const openStatusWindow = async () => {
    setStatusWindowError(null);
    try {
      await showStatusWindow();
    } catch (error) {
      setStatusWindowError(`状态窗打开失败 / WINDOW FAILED · ${String(error)}`);
    }
  };

  return (
    <main className="main-content dashboard-scene egress-monitor-page fade-in">
      <div className="egress-scene-heading">
        <DashboardSceneHeader title="出口监测" englishTitle="EGRESS MONITOR" index="04" onBack={onBack} />
        <nav className="egress-view-switch" aria-label="出口监测视图 / Egress monitor views">
          <button type="button" className={view === 'live' ? 'active' : ''} aria-pressed={view === 'live'} onClick={() => setView('live')}>
            <Activity size={14} /><span><b>实时线路</b><small>LIVE ROUTES</small></span>
          </button>
          <button type="button" className={view === 'details' ? 'active' : ''} aria-pressed={view === 'details'} onClick={() => setView('details')}>
            <History size={14} /><span><b>规则明细</b><small>RULE DETAILS</small></span>
          </button>
        </nav>
      </div>

      <div className="egress-status-strip">
        <div className={`egress-status-primary${mismatchSources.length > 0 ? ' has-mismatch' : ''}`}>
          {mismatchSources.length > 0
            ? <AlertTriangle size={20} aria-hidden="true" />
            : unknownSources.length > 0
              ? <CircleDot size={20} aria-hidden="true" />
              : <ShieldCheck size={20} aria-hidden="true" />}
          <span>
            <b>{mismatchSources.length > 0
              ? `${mismatchSources.length} 个出口异常`
              : `${matchedSources.length} 已验证 · ${unknownSources.length} 待观测`}</b>
            <small>REAL CONTROLLER EVIDENCE</small>
          </span>
          <i />
        </div>
        <div><small>实测主线路 / LIVE ROUTE</small><strong>{routeShortName(primaryRoute)}</strong></div>
        <div><small>规则命中 / MATCHED</small><strong>{String(matchedSources.length).padStart(2, '0')}</strong></div>
        <div><small>出口异常 / MISMATCHES</small><strong className="egress-deviation-value">{String(mismatchSources.length).padStart(2, '0')}</strong></div>
        <div><small>最后检测 / LAST CHECK</small><strong>{lastChecked ? lastChecked.toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--'}</strong></div>
      </div>

      {(snapshotError || firstWarning) && !primaryMismatch ? (
        <div className="egress-detection-notice" role="status">
          <WifiOff size={15} aria-hidden="true" />
          <span><b>{snapshotError ? '检测接口不可用 / DETECTION UNAVAILABLE' : '部分数据未观测 / PARTIAL EVIDENCE'}</b><small>{snapshotError ?? firstWarning}</small></span>
        </div>
      ) : null}

      {primaryMismatch ? (
        <section className="egress-mismatch-alert" role="alert" aria-live="assertive" aria-atomic="true">
          <div className="egress-mismatch-symbol" aria-hidden="true"><AlertTriangle size={21} /></div>
          <div className="egress-mismatch-summary">
            <span className="egress-mismatch-kicker">ERROR · EGRESS MISMATCH</span>
            <strong>实测出口与设定不一致 <small>/ ROUTE OUTSIDE BASELINE</small></strong>
            <p>{primaryMismatch.label} 的活跃连接已由本机代理控制器确认偏离固定线路。</p>
          </div>
          <dl className="egress-mismatch-detail">
            <div><dt>设定 / EXPECTED</dt><dd>{primaryMismatch.expectedRoute}</dd></div>
            <div><dt>实测 / OBSERVED</dt><dd>{primaryMismatch.verdict.actualRoute}</dd></div>
            <div><dt>代理入口 / PROXY</dt><dd>{proxyEndpoint}</dd></div>
            <div><dt>规则 / RULE</dt><dd><code>{primaryMismatch.verdict.actualRule}</code></dd></div>
          </dl>
          <div className="egress-mismatch-actions">
            <span>首次检测 {incidentDetectedAt?.toLocaleTimeString('zh-CN', { hour12: false }) ?? '--:--:--'}</span>
            <button type="button" onClick={locateMismatch}>定位线路 / LOCATE</button>
            <button type="button" onClick={recheckMismatch}>立即复检 / RECHECK</button>
          </div>
        </section>
      ) : null}

      {view === 'live' ? (
        <div className="egress-live-grid">
          <section className="egress-route-panel">
            <header className="egress-panel-header">
              <div><Network size={16} /><span><b>实时路由拓扑</b><small>LIVE ROUTE TOPOLOGY</small></span></div>
              <div className="egress-panel-actions">
                <span className={`egress-preview-badge${controllerLive ? ' is-live' : ''}`}>{loading ? '正在识别 / DETECTING' : controllerLabel}</span>
                {statusWindowError ? <span className="egress-window-error" role="status">{statusWindowError}</span> : null}
                <button
                  type="button"
                  className="egress-window-button"
                  onClick={() => void openStatusWindow()}
                  aria-label="打开简洁状态窗 / Open compact status window"
                  title="简洁状态窗 / STATUS WINDOW"
                >
                  <PanelTopOpen size={14} />
                  <span>简窗 / STATUS</span>
                </button>
                <button type="button" onClick={() => setPaused((value) => !value)} aria-label={paused ? '继续采样 / Resume' : '暂停采样 / Pause'} title={paused ? '继续 / Resume' : '暂停 / Pause'}>
                  {paused ? <Play size={14} /> : <Pause size={14} />}
                </button>
                <button type="button" onClick={() => void refreshNow()} disabled={requestingSnapshot} aria-label="立即检测 / Refresh now" title="立即检测 / Refresh now">
                  <RefreshCw size={14} className={requestingSnapshot ? 'is-spinning' : undefined} />
                </button>
              </div>
            </header>

            <div className="egress-route-map" data-selected-source={selectedSource}>
              <svg viewBox="0 0 840 250" role="img" aria-label="本机代理控制器实测的四类服务线路">
                <defs>
                  <linearGradient id="egress-route-line" x1="0" x2="1">
                    <stop offset="0" stopColor="currentColor" stopOpacity="0.14" />
                    <stop offset="0.52" stopColor="currentColor" stopOpacity="0.72" />
                    <stop offset="1" stopColor="currentColor" stopOpacity="0.26" />
                  </linearGradient>
                </defs>
                <g className="egress-map-grid">
                  <path d="M0 34H840M0 94H840M0 154H840M0 214H840" />
                  <path d="M80 0V250M390 0V250M700 0V250" />
                </g>
                {sourceSnapshots.map((source) => {
                  const y = SOURCE_Y[source.id];
                  const isDimmed = selectedSource !== 'all' && selectedSource !== source.id;
                  return (
                    <g key={source.id} className={`egress-route-source egress-source-${source.id}${source.verdict.isMismatch ? ' is-mismatch' : ''}${isDimmed ? ' is-dimmed' : ''}`}>
                      <path className="egress-route-base" d={`M96 ${y} C 224 ${y}, 262 125, 362 125`} />
                      <path className="egress-route-flow" d={`M96 ${y} C 224 ${y}, 262 125, 362 125`} />
                      <rect x="61" y={y - 15} width="30" height="30" />
                      <circle cx="76" cy={y} r="4" />
                      <text x="105" y={y - 8}>{source.short}</text>
                      <text className="egress-map-rate" x="105" y={y + 12}>{source.measurement.activeConnections} LIVE · ↓ {formatBytes(source.measurement.downloadBytes)}</text>
                    </g>
                  );
                })}
                <g className="egress-gateway-node">
                  <rect x="362" y="97" width="56" height="56" />
                  <circle cx="390" cy="125" r="13" />
                  <path d="M384 125h12M390 119v12" />
                  <text x="390" y="176">{controllerLive ? 'LOCAL CONTROLLER' : 'PROXY UNKNOWN'}</text>
                </g>
                <g className={`egress-exit-branch egress-main-branch${selectedSource === 'other' ? ' is-dimmed' : ''}`}>
                  <path className="egress-exit-base" d="M418 125 C 510 125, 560 75, 660 75" />
                  <path className="egress-exit-flow" d="M418 125 C 510 125, 560 75, 660 75" />
                  <g className="egress-exit-node">
                    <circle className="egress-exit-pulse main" cx="700" cy="75" r="36" />
                    <circle cx="700" cy="75" r="26" />
                    <circle cx="700" cy="75" r="7" />
                    <path d="M700 36v15M700 99v15M661 75h15M724 75h15" />
                    <text x="700" y="126">{routeShortName(primaryRoute).toUpperCase()}</text>
                    <text className="egress-exit-ip" x="700" y="141">{routeDetail(primaryRoute)}</text>
                  </g>
                </g>
                <g className={`egress-exit-branch egress-alt-branch${selectedSource !== 'all' && selectedSource !== 'other' ? ' is-dimmed' : ''}`}>
                  <path className="egress-exit-base" d="M418 125 C 510 125, 560 175, 660 175" />
                  <path className="egress-exit-flow" d="M418 125 C 510 125, 560 175, 660 175" />
                  <g className="egress-exit-node alternate">
                    <circle className="egress-exit-pulse alternate" cx="700" cy="175" r="30" />
                    <circle cx="700" cy="175" r="22" />
                    <circle cx="700" cy="175" r="6" />
                    <path d="M700 141v12M700 197v12M666 175h12M722 175h12" />
                    <text x="700" y="220">{routeShortName(otherRoute)}</text>
                    <text className="egress-exit-ip" x="700" y="235">OTHER · EXEMPT</text>
                  </g>
                </g>
              </svg>
            </div>

            <div
              ref={inspectorRef}
              tabIndex={-1}
              className={`egress-route-inspector${inspectedSource.verdict.isMismatch ? ' is-mismatch' : ''}`}
              aria-label={`${inspectedSource.label} 出口判定 / Egress verdict`}
            >
              <div className="egress-inspector-source"><SourceIcon source={inspectedSource.id} /><span><b>{inspectedSource.label}</b><small>{inspectedSource.english}</small></span></div>
              <dl>
                <div><dt>设定 / EXPECTED</dt><dd>{inspectedSource.expectedRoute}</dd></div>
                <div><dt>实测 / OBSERVED</dt><dd className={inspectedSource.verdict.isMismatch ? 'danger' : ''}>{inspectedSource.verdict.actualRoute}</dd></div>
                <div><dt>规则 / RULE</dt><dd><code>{inspectedSource.verdict.actualRule}</code></dd></div>
                <div><dt>判定 / RESULT</dt><dd className={inspectedSource.verdict.isMismatch ? 'danger' : inspectedSource.verdict.health === 'matched' ? 'success' : ''}>{resultLabel(inspectedSource.verdict.health)}</dd></div>
              </dl>
            </div>
          </section>

          <aside className="egress-source-panel">
            <header className="egress-panel-header">
              <div><CircleDot size={16} /><span><b>线路与规则</b><small>ROUTES &amp; RULES</small></span></div>
              <button type="button" className={selectedSource === 'all' ? 'active' : ''} onClick={() => setSelectedSource('all')}>全部 / ALL</button>
            </header>
            <div className="egress-source-list">
              {sourceSnapshots.map((source, index) => (
                <button
                  key={source.id}
                  type="button"
                  className={`${selectedSource === source.id ? 'active' : ''}${source.verdict.isMismatch ? ' is-mismatch' : ''}`}
                  aria-pressed={selectedSource === source.id}
                  aria-label={`${source.label}，${sourceStatusLabel(source.verdict.health)}，实测线路 ${source.verdict.actualRoute}`}
                  onClick={() => setSelectedSource((value) => value === source.id ? 'all' : source.id)}
                >
                  <span className="egress-source-index">0{index + 1}</span>
                  <span className="egress-source-icon"><SourceIcon source={source.id} /></span>
                  <span className="egress-source-name"><b>{source.label}</b><small>{source.english} · {source.measurement.activeConnections} LIVE · ↓ {formatBytes(source.measurement.downloadBytes)}</small></span>
                  <span className="egress-source-route"><b>{source.verdict.actualRoute}</b><small>实测线路 / OBSERVED</small></span>
                  <span className={`egress-source-rule${source.verdict.isMismatch ? ' danger' : ''}`}><b>{source.verdict.actualRule}</b><small>{sourceStatusLabel(source.verdict.health)}</small></span>
                </button>
              ))}
            </div>

            <div className="egress-fingerprint">
              <header><ShieldCheck size={15} /><span><b>规则审计</b><small>RULE AUDIT</small></span></header>
              <dl>
                <div><dt>证据来源 / EVIDENCE</dt><dd>{controllerLive ? '本机控制器 / LOCAL' : '不可用 / UNAVAILABLE'}</dd></div>
                <div><dt>固定命中 / MATCHED</dt><dd className="success">{matchedSources.length} / 3</dd></div>
                <div><dt>待观测 / UNKNOWN</dt><dd>{unknownSources.length}</dd></div>
                <div><dt>出口异常 / MISMATCHES</dt><dd className="danger">{mismatchSources.length}</dd></div>
                <div><dt>代理入口 / PROXY</dt><dd>{proxyEndpoint}</dd></div>
              </dl>
              <div className={`egress-consistency-meter${mismatchSources.length > 0 ? ' danger' : ''}`}><i style={{ width: `${(matchedSources.length / 3) * 100}%` }} /></div>
            </div>
          </aside>
        </div>
      ) : (
        <section className="egress-history-panel">
          <header className="egress-panel-header egress-history-toolbar">
            <div><History size={16} /><span><b>真实活动连接</b><small>CONTROLLER CONNECTIONS</small></span></div>
            <div className="egress-history-filters" role="status">
              <span>{snapshot?.controller.activeConnections ?? 0} ACTIVE</span>
              <span>{controllerLabel}</span>
            </div>
          </header>
          <div className="egress-history-source-filter" role="group" aria-label="流量来源筛选 / Traffic source filter">
            <button type="button" className={selectedSource === 'all' ? 'active' : ''} onClick={() => setSelectedSource('all')}>全部来源 / ALL SOURCES</button>
            {EGRESS_SOURCE_DEFINITIONS.map((source) => (
              <button key={source.id} type="button" className={selectedSource === source.id ? 'active' : ''} onClick={() => setSelectedSource(source.id)}>{source.label}</button>
            ))}
          </div>
          <div className="egress-history-table-wrap">
            <table className="egress-history-table">
              <thead><tr><th>#</th><th>来源 / SOURCE</th><th>目标 / TARGET</th><th>线路 / ROUTE</th><th>规则 / RULE</th><th>实测流量 / TRAFFIC</th><th>状态 / STATE</th></tr></thead>
              <tbody>
                {visibleConnections.map((row, index) => {
                  const source = getEgressSourceDefinition(row.source) ?? getEgressSourceDefinition('other')!;
                  const verdict = deriveEgressVerdict(source, connectionMeasurement(row));
                  const route = row.route ?? '未观测 / NO SAMPLE';
                  const rule = row.rule ?? (route.toLocaleLowerCase('en-US').includes('global') ? 'GLOBAL' : '未报告 / NOT REPORTED');
                  return (
                    <tr key={row.id} className={verdict.isMismatch ? 'is-mismatch' : ''}>
                      <td>{String(index + 1).padStart(2, '0')}</td>
                      <td><span className="egress-history-source"><SourceIcon source={source.id} size={15} /><span><b>{source.label}</b><small>{row.process ?? 'PROCESS UNRESOLVED'}</small></span></span></td>
                      <td>{row.target}</td>
                      <td><span className={verdict.isMismatch ? 'egress-route-deviation' : 'egress-route-match'}>{verdict.isMismatch ? <AlertTriangle size={13} aria-hidden="true" /> : <ShieldCheck size={13} aria-hidden="true" />}{route}</span></td>
                      <td><code className="egress-rule-code">{rule}</code></td>
                      <td><span className="egress-history-traffic">↓ {formatBytes(row.downloadBytes)}<small>↑ {formatBytes(row.uploadBytes)} · {elapsedSince(row.start)}</small></span></td>
                      <td><span className="egress-history-state active">活跃 / ACTIVE</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleConnections.length === 0 ? <div className="egress-history-empty">当前没有可验证的活动连接 / NO VERIFIED ACTIVE CONNECTIONS</div> : null}
          </div>
        </section>
      )}
    </main>
  );
}
