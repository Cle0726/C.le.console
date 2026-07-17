interface ApiServicesPageProps {
  onOpenMultiProxy(): void;
  onOpenClaudeGateway(): void;
}

export function ApiServicesPage({ onOpenMultiProxy, onOpenClaudeGateway }: ApiServicesPageProps) {
  return (
    <main className="page-shell">
      <section className="panel status-panel">
        <div>
          <p className="eyebrow">API 服务中心</p>
          <h1>本地反代服务控制台</h1>
          <p className="subtle">
            统一管理本地 OpenAI-compatible 反代、多平台账号池和 Claude 反代接口。入口样式与现有 API 服务页面保持一致。
          </p>
        </div>

        <div className="service-grid">
          <article className="service-card">
            <div>
              <p className="eyebrow">Multi Provider</p>
              <h2>多平台 API 反代</h2>
              <p className="subtle">统一入口、模型路由、账号轮询、Antigravity/Codex per-account smoke 路由。</p>
            </div>
            <div className="status-grid compact">
              <div className="status-pill">
                <span>Base URL</span>
                <code>127.0.0.1:13978/v1</code>
              </div>
              <div className="status-pill">
                <span>协议</span>
                <strong>OpenAI-compatible</strong>
              </div>
            </div>
            <div className="button-row">
              <button className="primary" onClick={onOpenMultiProxy}>打开多平台服务</button>
            </div>
          </article>

          <article className="service-card">
            <div>
              <p className="eyebrow">Claude</p>
              <h2>Claude 反代接口</h2>
              <p className="subtle">接入你已有的 Claude 反代方法和接口 UI，保留登录、账号池、Transport 和测试发送能力。</p>
            </div>
            <div className="status-grid compact">
              <div className="status-pill">
                <span>默认端口</span>
                <code>127.0.0.1:8787/v1</code>
              </div>
              <div className="status-pill">
                <span>模式</span>
                <strong>Claude Web Gateway</strong>
              </div>
            </div>
            <div className="button-row">
              <button className="primary" onClick={onOpenClaudeGateway}>打开 Claude 服务</button>
            </div>
          </article>
        </div>
      </section>
    </main>
  );
}
