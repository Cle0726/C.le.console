import type { AuthExportStatus, GatewayStatus } from '@desktop/contracts';

interface GatewayStatusCardProps {
  status: GatewayStatus;
  authStatus: AuthExportStatus | null;
  saving: boolean;
  busy: boolean;
  onToggle(nextRunning: boolean): Promise<void>;
  onLaunchLogin(): Promise<void>;
  onSaveAll(): Promise<void>;
  onCopyApiUrl(): Promise<void>;
  onTestChat(): Promise<void>;
}

export function GatewayStatusCard({
  status,
  authStatus,
  saving,
  busy,
  onToggle,
  onLaunchLogin,
  onSaveAll,
  onCopyApiUrl,
  onTestChat,
}: GatewayStatusCardProps) {
  const authLabel = authStatus?.authenticated ? '已登录' : '未登录';

  return (
    <section className="panel status-panel">
      <div>
        <p className="eyebrow">API 代理服务</p>
        <h1>Claude Web API Gateway</h1>
        <p className="subtle">
          本地监听 <strong>{status.listenHost}:{status.listenPort}</strong>，对外兼容 OpenAI Chat Completions。
        </p>
      </div>

      <div className="status-grid">
        <div className="status-pill">
          <span>服务状态</span>
          <strong className={status.running ? 'ok' : 'muted'}>{status.running ? '运行中' : '未启动'}</strong>
        </div>
        <div className="status-pill">
          <span>认证状态</span>
          <strong className={authStatus?.authenticated ? 'ok' : 'warn'}>{authLabel}</strong>
        </div>
        <div className="status-pill wide">
          <span>API Base URL</span>
          <code>{status.apiBaseUrl}</code>
        </div>
        <div className="status-pill">
          <span>Sidecar PID</span>
          <strong>{status.sidecarPid ?? '—'}</strong>
        </div>
        <div className="status-pill wide">
          <span>上游 Claude URL</span>
          <code>{status.upstreamBaseUrl}</code>
        </div>
        <div className="status-pill">
          <span>Transport</span>
          <strong>{status.transportMode}</strong>
        </div>
        <div className="status-pill">
          <span>Helper 模式</span>
          <strong>{status.helperMode}</strong>
        </div>
        <div className="status-pill">
          <span>流式能力</span>
          <strong className={status.supportsStreaming ? 'ok' : 'warn'}>{status.supportsStreaming ? '支持' : '未启用'}</strong>
        </div>
      </div>

      {status.lastError ? <p className="error-text">最近错误：{status.lastError}</p> : null}

      <div className="gateway-toolbar">
        <div className="toggle-block">
          <span className="toggle-label">服务总开关</span>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={status.running}
              disabled={busy}
              onChange={(event) => void onToggle(event.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
          <strong className={status.running ? 'ok' : 'muted'}>{status.running ? '运行中' : '已停止'}</strong>
        </div>

        <div className="button-row">
          <button className="secondary" disabled={busy} onClick={() => void onCopyApiUrl()}>
            复制 API URL
          </button>
          <button className="primary" disabled={busy || !status.running} onClick={() => void onTestChat()}>
            测试发送：你好
          </button>
          <button className="secondary" disabled={busy} onClick={() => void onLaunchLogin()}>
            打开 Claude 登录
          </button>
          <button className="ghost" disabled={saving || busy} onClick={() => void onSaveAll()}>
            {saving ? '保存中…' : '保存全部配置'}
          </button>
        </div>
      </div>
    </section>
  );
}
